"""Run the installed p2midi engine with a smaller separation window."""

import sys
from pathlib import Path

import yaml

SEPARATOR_CHUNK_SAMPLES = 147456  # About 3.3 s at 44.1 kHz; aligned to the model's STFT hop.


def write_config(source, destination):
    # The installed MSST config includes Python tuple tags, which MSST reads with FullLoader.
    config = yaml.load(source.read_text(), Loader=yaml.FullLoader)
    inference = config["inference"]
    original_size = inference.get("chunk_size", config["audio"]["chunk_size"])
    inference["chunk_size"] = min(original_size, SEPARATOR_CHUNK_SAMPLES)
    inference["batch_size"] = 1
    destination.write_text(yaml.dump(config, sort_keys=False))
    return inference["chunk_size"] / config["audio"]["sample_rate"]


def main():
    engine_dir = Path(sys.argv[1]).resolve()
    config_path = Path(sys.argv[2]).resolve()
    sys.argv = [str(engine_dir / "p2midi.py"), *sys.argv[3:]]
    sys.path.insert(0, str(engine_dir))
    import p2midi

    if p2midi.BSROFO_YAML.is_file():
        seconds = write_config(p2midi.BSROFO_YAML, config_path)
        p2midi.BSROFO_YAML = config_path
        print(f"Separating audio in {seconds:.1f}-second chunks to reduce memory use.", flush=True)
    p2midi.main()


if __name__ == "__main__":
    main()
