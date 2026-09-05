import os
import re
import json
import base64
import asyncio
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Gemini Live API — continuous two-way voice
# ---------------------------------------------------------------------------

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
genai_client = genai.Client(api_key=GEMINI_API_KEY)

LIVE_MODEL = "gemini-2.5-flash-preview-native-audio-dialog"
# If you want the cheaper half-cascade option instead:
# LIVE_MODEL = "gemini-2.5-flash-preview-live"


def build_live_config(voice_name: str = "Aoede") -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name=voice_name
                )
            )
        ),
        # VAD handles turn-taking automatically — key for continuous talk
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )


async def receive_from_gemini(session, websocket: WebSocket):
    """
    Forward Gemini -> browser, FOREVER.

    IMPORTANT: session.receive() completes at the end of each model turn.
    A single `async for` would exit after the first answer and kill the
    pipeline. The outer `while True` re-enters receive() after every
    turnComplete so the same session keeps answering question after question.
    """
    try:
        while True:
            async for response in session.receive():
                if websocket.client_state.name != "CONNECTED":
                    return

                server_content = response.server_content
                if server_content is None:
                    continue

                model_turn = server_content.model_turn
                if model_turn:
                    for part in model_turn.parts:
                        # Native-audio models stream PCM in inline_data
                        if part.inline_data and part.inline_data.data:
                            audio_b64 = base64.b64encode(
                                part.inline_data.data
                            ).decode("utf-8")
                            await websocket.send_json({
                                "type": "audio",
                                "data": audio_b64,
                            })
                        elif part.text:
                            await websocket.send_json({
                                "type": "text",
                                "data": part.text,
                            })

                if server_content.input_transcription and \
                        server_content.input_transcription.text:
                    await websocket.send_json({
                        "type": "input_transcript",
                        "data": server_content.input_transcription.text,
                    })

                if server_content.output_transcription and \
                        server_content.output_transcription.text:
                    await websocket.send_json({
                        "type": "output_transcript",
                        "data": server_content.output_transcription.text,
                    })

                if server_content.interrupted:
                    await websocket.send_json({"type": "interrupted"})

                if server_content.turn_complete:
                    await websocket.send_json({"type": "turnComplete"})

            # turn finished -> loop back and receive() the next turn
            await asyncio.sleep(0)
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[LIVE VOICE] Receive error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "data": f"Gemini stream error: {e}",
            })
        except Exception:
            pass


async def send_to_gemini(session, websocket: WebSocket):
    """
    Forward browser -> Gemini, FOREVER.

    Mic audio arrives as base64 16-bit PCM @ 16kHz and is streamed with
    send_realtime_input — NOT send_client_content — so it never resets the
    turn and the VAD can detect speech continuously.
    """
    try:
        while True:
            message = await websocket.receive_json()

            msg_type = message.get("type")

            if msg_type == "audio":
                pcm_bytes = base64.b64decode(message["data"])
                await session.send_realtime_input(
                    audio=types.Blob(
                        data=pcm_bytes,
                        mime_type="audio/pcm;rate=16000",
                    )
                )

            elif msg_type == "text":
                await session.send_client_content(
                    turns=types.Content(
                        role="user",
                        parts=[types.Part(text=message["data"])],
                    )
                )

            elif msg_type == "image":
                # Optional: screen/page snapshots mid-call
                image_bytes = base64.b64decode(message["data"])
                await session.send_realtime_input(
                    video=types.Blob(
                        data=image_bytes,
                        mime_type=message.get("mimeType", "image/jpeg"),
                    )
                )

    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[LIVE VOICE] Send error: {e}")


@app.websocket("/ws/live-voice")
async def live_voice(websocket: WebSocket):
    await websocket.accept()
    print("[LIVE VOICE] Client connected")

    # Optional: pick voice / inject PDF context via query params
    voice_name = websocket.query_params.get("voice", "Aoede")
    doc_context: Optional[str] = websocket.query_params.get("context")

    config = build_live_config(voice_name)
    if doc_context:
        config.system_instruction = (
            "You are a helpful assistant answering questions about this "
            "document. Keep spoken answers concise and conversational.\n\n"
            f"DOCUMENT:\n{doc_context[:30000]}"
        )

    try:
        async with genai_client.aio.live.connect(
            model=LIVE_MODEL, config=config
        ) as session:
            print("[LIVE VOICE] Gemini session opened")

            sender = asyncio.create_task(send_to_gemini(session, websocket))
            receiver = asyncio.create_task(receive_from_gemini(session, websocket))

            done, pending = await asyncio.wait(
                {sender, receiver},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                if task.exception():
                    raise task.exception()

    except WebSocketDisconnect:
        print("[LIVE VOICE] Client disconnected")
    except Exception as e:  # <-- stray 'ch' removed here
        print(f"[LIVE VOICE] Unexpected error: {e}")
        try:
            await websocket.send_json({"type": "error", "data": str(e)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
        print("[LIVE VOICE] Connection closed")
