#!/usr/bin/env python3
"""Local web server and job runner for AIccompanist audio-to-MIDI conversion."""

from __future__ import annotations

import json
import os
import platform
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
import uuid
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
CRUCIAL_HOME = Path("/Volumes/Crucial External SSD/AIccompanist")
EXTERNAL_P2MIDI_DIR = CRUCIAL_HOME / "p2midi"
DEFAULT_P2MIDI_DIR = EXTERNAL_P2MIDI_DIR if (EXTERNAL_P2MIDI_DIR / "run.sh").is_file() else ROOT / "p2midi"
DEFAULT_JOBS_DIR = CRUCIAL_HOME / "jobs" if DEFAULT_P2MIDI_DIR == EXTERNAL_P2MIDI_DIR else ROOT / ".aiccompanist-jobs"
# Some managed Python environments can't access macOS's normal temp paths.
# Keep short-lived uploads and conversion outputs beside the external engine when present.
JOBS_ROOT = Path(os.environ.get("AICCOMPANIST_JOBS_DIR", DEFAULT_JOBS_DIR)).expanduser()
JOBS_ROOT.mkdir(parents=True, exist_ok=True)
P2MIDI_DIR = Path(os.environ.get("AICCOMPANIST_P2MIDI_DIR", DEFAULT_P2MIDI_DIR)).expanduser()
MAX_UPLOAD = 250 * 1024 * 1024
ALLOWED_EXTENSIONS = {
    ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".aiff", ".aif",
    ".wma", ".mp4", ".mov", ".mkv", ".webm", ".avi", ".mpeg", ".mpg",
}
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"}
LOCK = threading.Lock()
JOBS: dict[str, dict] = {}
ACTIVE_STATES = {"queued", "running", "cancelling"}


def conversion_progress(line, stage):
    """Translate the engine's stage logs into progress within that stage."""
    line = line.strip()
    if line.startswith("[BS-Roformer] separating") or line.startswith("[demucs] htdemucs_6s"):
        return "separation", "Separating piano from the mix…", None
    if line.startswith("[aria-amt] transcribing"):
        return "transcription", "Transcribing piano notes…", None
    if stage == "separation":
        match = re.match(r"(?:Processing audio chunks:\s*)?(\d+)%\|", line)
        if match:
            percent = min(100, int(match[1]))
            if percent:
                return stage, "Separating piano from the mix…", percent
    if stage == "transcription":
        match = re.match(r"window (\d+)/(\d+)\s", line)
        if match and int(match[2]):
            return stage, "Transcribing piano notes…", min(100, 100 * int(match[1]) // int(match[2]))
    return None


def cancel_job_locked(job):
    job.update(state="cancelling", message="Stopping conversion…", progress=None)
    process = job.get("process")
    if process and process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("[web] " + fmt % args)

    def _json(self, value, status=200):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _post_is_local(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == self.server.server_port

    def do_POST(self):
        if not self._post_is_local():
            return self._json({"error": "Requests must come from the local app."}, 403)
        if self.path == "/api/jobs/upload":
            return self._upload()
        if self.path == "/api/jobs/youtube":
            return self._youtube()
        cancel = re.fullmatch(r"/api/jobs/([a-f0-9]{32})/cancel", self.path)
        if cancel:
            with LOCK:
                job = JOBS.get(cancel[1])
                if job and job["state"] in {"queued", "running"}:
                    cancel_job_locked(job)
            return self._json({"ok": True} if job else {"error": "Conversion not found."}, 200 if job else 404)
        self._json({"error": "Unknown endpoint."}, 404)

    def _new_job(self, fast=False, preview=False):
        with LOCK:
            if any(job["state"] in ACTIVE_STATES for job in JOBS.values()):
                return None
            job_id = uuid.uuid4().hex
            directory = JOBS_ROOT / job_id
            directory.mkdir()
            record = {"id": job_id, "directory": directory, "state": "queued", "message": "Queued for processing", "logs": [], "midi": None, "fast": fast, "preview": preview, "progress": None, "started": time.monotonic()}
            JOBS[job_id] = record
        return record

    def _work(self, job_id, target, *args):
        try:
            target(job_id, *args)
        except Exception as exc:
            self._append_log(job_id, str(exc))
            self._set_job(job_id, state="error", message=str(exc))
        finally:
            with LOCK:
                job = JOBS[job_id]
                if job["state"] == "cancelling":
                    job.update(state="cancelled", message="Conversion cancelled.")

    def _run_command(self, job_id, command, on_line=None, **kwargs):
        with LOCK:
            job = JOBS[job_id]
            if job["state"] == "cancelling":
                return -1
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, errors="replace", start_new_session=True, **kwargs)
            job["process"] = process
        try:
            with process.stdout as output:
                for line in output:
                    if on_line:
                        on_line(line)
                    else:
                        self._append_log(job_id, line)
            return process.wait()
        finally:
            with LOCK:
                job.pop("process", None)

    def _upload(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json({"error": "Invalid upload size."}, 400)
        if size <= 0 or size > MAX_UPLOAD:
            return self._json({"error": "Choose a file smaller than 250 MB."}, 413)
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            return self._json({"error": "Expected an audio or video file upload."}, 400)
        body = self.rfile.read(size)
        envelope = BytesParser(policy=policy.default).parsebytes(
            b"MIME-Version: 1.0\r\nContent-Type: " + content_type.encode() + b"\r\n\r\n" + body
        )
        uploaded = None
        original_name = ""
        fast = False
        preview = False
        for part in envelope.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if field_name == "file":
                original_name = part.get_filename() or "audio"
                uploaded = part.get_payload(decode=True)
            elif field_name == "fast":
                fast = (part.get_payload(decode=True) or b"").decode(errors="ignore").lower() == "true"
            elif field_name == "preview":
                preview = (part.get_payload(decode=True) or b"") == b"true"
        suffix = Path(original_name).suffix.lower()
        if not uploaded or suffix not in ALLOWED_EXTENSIONS:
            return self._json({"error": "Choose a supported audio or video file (MP3, WAV, M4A, MP4, and more)."}, 400)
        job = self._new_job(fast=fast, preview=preview)
        if not job:
            return self._json({"error": "A conversion is already running. Finish or cancel it before starting another."}, 409)
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(original_name).name)[:120] or "audio" + suffix
        input_path = job["directory"] / safe_name
        try:
            input_path.write_bytes(uploaded)
        except OSError as exc:
            self._set_job(job["id"], state="error", message=str(exc))
            return self._json({"error": "Could not save the uploaded file. Check that the drive is connected and has space."}, 500)
        threading.Thread(target=self._work, args=(job["id"], self._run_conversion, input_path), daemon=True).start()
        self._json({"id": job["id"]}, 202)

    def _youtube(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 16384:
                raise ValueError
            payload = json.loads(self.rfile.read(size))
            url = payload.get("url", "")
        except (ValueError, json.JSONDecodeError):
            return self._json({"error": "Enter a valid YouTube link."}, 400)
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in YOUTUBE_HOSTS:
            return self._json({"error": "Paste a link from youtube.com or youtu.be."}, 400)
        job = self._new_job(fast=payload.get("fast") is True, preview=payload.get("preview") is True)
        if not job:
            return self._json({"error": "A conversion is already running. Finish or cancel it before starting another."}, 409)
        threading.Thread(target=self._work, args=(job["id"], self._download_youtube, url), daemon=True).start()
        self._json({"id": job["id"]}, 202)

    def _append_log(self, job_id, line):
        line = line.rstrip()
        if not line:
            return
        with LOCK:
            job = JOBS.get(job_id)
            if job:
                job["logs"].append(line[-1000:])
                job["logs"] = job["logs"][-80:]

    def _set_job(self, job_id, **updates):
        with LOCK:
            if job_id in JOBS and JOBS[job_id]["state"] != "cancelling":
                JOBS[job_id].update(updates)

    def _download_youtube(self, job_id, url):
        with LOCK:
            job = JOBS[job_id]
            directory = job["directory"]
        self._set_job(job_id, state="running", message="Getting audio from YouTube…")
        if not shutil.which("yt-dlp"):
            self._append_log(job_id, "yt-dlp is missing. Install it with: python3 -m pip install yt-dlp")
            self._set_job(job_id, state="error", message="Install yt-dlp, then restart AIccompanist.")
            return
        template = str(directory / "source.%(ext)s")
        command = ["yt-dlp", "--no-playlist", "--no-progress", "--max-filesize", "200M", "-f", "bestaudio/best", "-o", template, url]
        try:
            certificate_error = False
            def on_line(line):
                nonlocal certificate_error
                if "CERTIFICATE_VERIFY_FAILED" in line or "unable to get local issuer certificate" in line:
                    certificate_error = True
                self._append_log(job_id, line)
            code = self._run_command(job_id, command, on_line)
            if code != 0:
                if certificate_error:
                    raise RuntimeError(
                        "Python cannot verify YouTube's HTTPS certificate. In Finder, open Applications → Python 3.11 → "
                        "Install Certificates.command. When it says 'update complete', restart AIccompanist and try again."
                    )
                raise RuntimeError("yt-dlp could not retrieve this video. Check the link and try again.")
            candidates = [p for p in directory.glob("source.*") if p.suffix.lower() in ALLOWED_EXTENSIONS]
            if not candidates:
                raise RuntimeError("YouTube did not provide a supported audio format.")
            self._run_conversion(job_id, candidates[0])
        except Exception as exc:
            self._append_log(job_id, str(exc))
            self._set_job(job_id, state="error", message=str(exc))

    def _run_conversion(self, job_id, input_path):
        with LOCK:
            job = JOBS.get(job_id)
            if not job or job["state"] == "cancelling":
                return
            directory = job["directory"]
        self._set_job(job_id, state="running", message="Preparing audio and loading the models…")
        command_setting = os.environ.get("AICCOMPANIST_P2MIDI", "").strip()
        if command_setting:
            command = shlex.split(command_setting)
        else:
            runner = P2MIDI_DIR / "run.sh"
            if not runner.is_file():
                self._set_job(job_id, state="error", message="YouTube audio was downloaded, but the piano transcription engine is missing. Set up ./p2midi using the README instructions (the first setup downloads about 1.1 GB), then retry.")
                return
            python = P2MIDI_DIR / ".venv" / "bin" / "python"
            if not python.is_file():
                self._set_job(job_id, state="error", message=f"The transcription setup at {P2MIDI_DIR} is incomplete. See README.md.")
                return
            if job["fast"]:
                command = ["bash", str(runner)]
            else:
                command = [str(python), str(ROOT / "run_separator.py"), str(P2MIDI_DIR),
                           str(directory / "separator.yaml")]
        output_dir = directory / "out"
        output_dir.mkdir(exist_ok=True)
        if job["preview"]:
            self._set_job(job_id, message="Preparing the first 30 seconds…")
            clip = directory / "preview.wav"
            code = self._run_command(job_id, ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                                              "-threads", "1", "-i", str(input_path), "-t", "30",
                                              "-map", "0:a:0", "-c:a", "pcm_s16le", str(clip)])
            if code != 0:
                raise RuntimeError("Could not prepare the audio preview.")
            input_path = clip
            self._set_job(job_id, message="Loading the models for your preview…")
        command += [str(input_path), "--no-render", "--out", str(output_dir)]
        if job.get("fast"):
            command += ["--separator", "demucs"]
        self._append_log(job_id, "Starting local piano separation and transcription.")
        env = os.environ.copy()
        env.update(PYTHONUNBUFFERED="1", OMP_NUM_THREADS="2", MKL_NUM_THREADS="2",
                   OPENBLAS_NUM_THREADS="2", VECLIB_MAXIMUM_THREADS="2")
        if platform.system() == "Darwin" and platform.machine() == "arm64":
            if "PYTORCH_MPS_HIGH_WATERMARK_RATIO" not in env:
                env["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.8"
                env.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.65")
        env.setdefault("TORCH_HOME", str(JOBS_ROOT / ".torch-cache"))
        if nice := shutil.which("nice"):
            command = [nice, "-n", "10", *command]
        try:
            setup_error = False
            memory_error = False
            stage = "loading"
            def on_line(line):
                nonlocal setup_error, memory_error, stage
                if "The environment isn't set up." in line or "ModuleNotFoundError" in line:
                    setup_error = True
                if re.search(r"\b(out of memory|cannot allocate memory|not enough memory|SIGKILL)\b", line, re.IGNORECASE):
                    memory_error = True
                progress = conversion_progress(line, stage)
                if progress:
                    stage, message, percent = progress
                    self._set_job(job_id, message=message, progress=percent)
                if re.match(r"\s*(?:Processing audio chunks:\s*)?\d+%\|", line):
                    return  # The progress meter replaces these console redraws.
                self._append_log(job_id, line)
            code = self._run_command(job_id, command, on_line, env=env,
                                     cwd=str(P2MIDI_DIR) if not command_setting else str(ROOT))
            midi_files = list(output_dir.glob("*.mid"))
            if code != 0 or not midi_files:
                if setup_error:
                    raise RuntimeError(f"The transcription setup at {P2MIDI_DIR} is incomplete. Follow the setup steps in README.md, then retry.")
                if memory_error or code == -signal.SIGKILL:
                    if job["state"] == "cancelling":
                        return
                    step = "Piano separation" if stage == "separation" else "Conversion"
                    hint = (" Try Faster conversion." if not job["fast"] else "")
                    if not job["preview"]:
                        hint += " Try a 30-second preview before converting the whole song."
                    raise RuntimeError(f"{step} was stopped, possibly due to memory pressure.{hint}")
                raise RuntimeError("Transcription did not finish. See the log above for details.")
            midi_file = midi_files[0]
            self._set_job(job_id, state="done", message="Piano MIDI is ready.", midi=str(midi_file))
        except Exception as exc:
            self._append_log(job_id, str(exc))
            self._set_job(job_id, state="error", message=str(exc))

    def do_GET(self):
        if self.path == "/api/jobs/active":
            with LOCK:
                job_id = next((job["id"] for job in JOBS.values() if job["state"] in ACTIVE_STATES), None)
            return self._json({"id": job_id})
        if self.path.startswith("/api/jobs/"):
            parts = self.path.strip("/").split("/")
            if len(parts) == 4 and parts[3] == "midi":
                return self._download_midi(parts[2])
            if len(parts) == 3:
                with LOCK:
                    job = JOBS.get(parts[2])
                    if not job:
                        return self._json({"error": "This conversion could not be found."}, 404)
                    result = {key: job[key] for key in ("id", "state", "message", "logs", "progress", "preview")}
                    result["elapsed"] = int(time.monotonic() - job["started"])
                return self._json(result)
        return super().do_GET()

    def _download_midi(self, job_id):
        with LOCK:
            job = JOBS.get(job_id)
            midi = Path(job["midi"]) if job and job.get("midi") else None
        if not midi or not midi.is_file():
            return self._json({"error": "The MIDI file is not ready."}, 404)
        payload = midi.read_bytes()
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", midi.name)
        self.send_response(200)
        self.send_header("Content-Type", "audio/midi")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"AIccompanist is running at http://localhost:{port}")
    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            with LOCK:
                for job in JOBS.values():
                    if job["state"] in ACTIVE_STATES:
                        cancel_job_locked(job)
