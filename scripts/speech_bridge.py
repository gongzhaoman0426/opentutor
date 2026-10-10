"""Small JSON-only bridge to Microsoft's online Edge Read Aloud service."""
import asyncio
import inspect
import json
import os
import sys

import edge_tts


async def main():
    request = json.load(sys.stdin)
    action = request.get("action")
    if action == "health":
        from importlib.metadata import version
        print(json.dumps({"ready": True, "version": version("edge-tts")}))
        return
    if action == "voices":
        voices = await asyncio.wait_for(edge_tts.list_voices(), timeout=30)
        print(json.dumps({"voices": [
            {"name": voice["ShortName"], "locale": voice["Locale"], "gender": voice["Gender"],
             "displayName": voice.get("FriendlyName", voice["ShortName"])} for voice in voices
        ]}, ensure_ascii=False))
        return
    if action != "synthesize":
        raise ValueError("Unknown bridge operation")
    text, voice, output = request["text"], request["voice"], request["output"]
    if not isinstance(text, str) or not 0 < len(text) <= 4000:
        raise ValueError("Invalid utterance length")
    rate = int(request["rate"])
    if not -50 <= rate <= 100:
        raise ValueError("Invalid rate")
    arguments = {"rate": f"{rate:+d}%", "connect_timeout": 15, "receive_timeout": 60}
    # Pin 7.2.8, but tolerate earlier installations without pretending sentence metadata exists.
    if "boundary" in inspect.signature(edge_tts.Communicate).parameters:
        arguments["boundary"] = "SentenceBoundary"
    communicator = edge_tts.Communicate(text, voice, **arguments)
    boundaries = []
    audio_bytes = 0
    try:
        with open(output, "wb") as audio:
            async for chunk in communicator.stream():
                if chunk["type"] == "audio":
                    audio.write(chunk["data"])
                    audio_bytes += len(chunk["data"])
                elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                    boundaries.append({"kind": "sentence" if chunk["type"] == "SentenceBoundary" else "word",
                                       "text": chunk["text"], "offsetTicks": chunk["offset"], "durationTicks": chunk["duration"]})
        if audio_bytes < 100:
            raise ValueError("No audio received")
        print(json.dumps({"boundaries": boundaries, "audioBytes": audio_bytes}, ensure_ascii=False))
    except BaseException:
        try:
            os.unlink(output)
        except OSError:
            pass
        raise


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # No stack traces/remote URLs or headers on stdout; the caller turns this into a clear stage failure.
        print(json.dumps({"error": type(error).__name__}), flush=True)
        sys.exit(1)
