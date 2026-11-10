# AIccompanist

AIccompanist can import and play MIDI files, or try to extract a piano accompaniment from a song and convert it to MIDI. Audio/video processing runs locally on your computer.

## One-time setup for audio-to-MIDI

The transcription engine uses [p2midi](https://github.com/madebycm/p2midi), which chains a piano separation model and a piano transcription model. Its first-time setup downloads about 1.1 GB of model files. It needs Python 3.11, `uv`, Git, and `ffmpeg`.

On macOS with Homebrew, install the prerequisites:

```sh
brew install uv ffmpeg yt-dlp
```

For this setup, the transcription engine is stored on the mounted Crucial SSD. Clone the engine there and keep uv's package cache there too:

```sh
CRUCIAL="/Volumes/Crucial External SSD/AIccompanist"
mkdir -p "$CRUCIAL/uv-cache"
git clone https://github.com/madebycm/p2midi.git "$CRUCIAL/p2midi"
cd "$CRUCIAL/p2midi"
UV_CACHE_DIR="$CRUCIAL/uv-cache" ./setup.sh
```

If the `p2midi` folder already exists, skip `git clone` and run the last two commands from that folder. Setup downloads about 1.1 GB and should finish by printing `Done`. AIccompanist automatically uses this Crucial SSD install for the engine and conversion files when the drive is mounted.

On Linux, install `uv`, Git, `ffmpeg`, and `yt-dlp` using your package manager, then run the same `git clone` and `./setup.sh` commands. See the p2midi README for platform-specific requirements and troubleshooting.

The aria-amt model weights used by this pipeline are licensed for noncommercial use (CC-BY-NC-SA-4.0). Check the model terms before using it commercially.

## Start the app

From this folder, run:

```sh
python3 server.py
```

Open [http://localhost:8000](http://localhost:8000). The web app can accept an audio/video file or a YouTube link, then make a piano MIDI that you can download and play in the built-in player. Select **Faster conversion** to use the quicker Demucs separator; it may give a rougher piano stem than the default separator. YouTube link processing requires `yt-dlp`. Supported uploads include common audio and video formats up to 250 MB.

If a YouTube link fails with `CERTIFICATE_VERIFY_FAILED` on the python.org macOS installer, open **Applications → Python 3.11 → Install Certificates.command**, wait for `update complete`, then stop and restart AIccompanist. Keep certificate verification enabled.

Audio-to-MIDI takes time and works best when the piano is audible in the mix. It may include mistakes or miss notes, so review the resulting MIDI. Vocal and accompaniment separation is an estimate. The app limits YouTube processing to links from YouTube domains; only process material you have permission to use.

To try a song without processing the whole thing, select **30-second preview** before choosing a file or submitting a link. Model loading still happens for a preview. The status shows elapsed time and a percentage when the current step reports one. Use **Cancel** to stop an active conversion; AIccompanist runs one conversion at a time and gives it lower CPU priority to leave room for other apps.

AIccompanist runs the default separator on shorter audio chunks to reduce peak memory use. On Apple Silicon it also limits PyTorch GPU allocations. If a conversion is stopped because of memory pressure, try **Faster conversion** with **30-second preview** enabled.

## MIDI player only

MIDI playback uses the browser's Web Audio API and a simple synthesized tone. If you only need the MIDI player, run `python3 -m http.server 8000` instead; audio-to-MIDI conversion requires `server.py` and the one-time setup above.
