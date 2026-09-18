from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List
from dotenv import load_dotenv
import json
import os
import requests
from requests.exceptions import RequestException

load_dotenv()

class VerifyRequest(BaseModel):
    text: str = Field(..., min_length=200, description="Text to verify for authenticity")

class VerifyResponse(BaseModel):
    score: float
    explanation: List[str]

app = FastAPI(
    title="Text Authenticity Checker",
    description="Backend service to classify text authenticity as red, amber, or green.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

MODEL_NAME = os.getenv("VERIFY_MODEL", "gemini-2.5-flash")
print("Using model:", MODEL_NAME)

def build_validation_prompt(text: str) -> str:
    return (
        "You are a fact-validation assistant. Evaluate the following text for authenticity and truthfulness. "
        "Return only JSON with the following fields: score, explanation. "
        "score must be a number from 0.0 to 1.0 representing how credible the text is, where: "
        "0.7–1.0 means factually supported with no misleading framing, "
        "0.4–0.69 means unverified claims or missing context, "
        "0.0–0.39 means demonstrably false or highly manipulative. "
        "explanation must be exactly 3 short points explaining the assessment. "
        "Each explanation point must be no longer than 100 characters. "
        "Do not use markdown formatting or additional text outside the JSON object. "
        "If the text is very long, focus on the main factual claim and assess whether it is supported by evidence. "
        "Text:\n---BEGIN TEXT---\n" + text + "\n---END TEXT---"
    )


def parse_validation_response(response_text: str) -> dict:
    text = response_text.strip()
    # Strip markdown code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        text = text.rsplit("```", 1)[0].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and start < end:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
        raise ValueError("Unable to parse JSON from model response.")


def analyze_text(text: str) -> dict:
    if not text.strip():
        raise ValueError("Text must not be empty.")
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GOOGLE_API_KEY not set in environment")

    prompt = build_validation_prompt(text)

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 2048},
    }

    try:
        resp = requests.post(url, json=payload, timeout=30, headers={"X-goog-api-key": api_key, "Content-Type": "application/json"})
    except RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Request to Gemini failed: {exc}")

    if resp.status_code == 429:
        retry_after = 60
        try:
            for detail in resp.json().get("error", {}).get("details", []):
                if delay := detail.get("retryDelay"):
                    retry_after = int(float(delay.rstrip("s")))
                    break
        except Exception:
            pass
        raise HTTPException(status_code=429, detail="Rate limited by Gemini", headers={"Retry-After": str(retry_after)})

    if not resp.ok:
        raise HTTPException(status_code=502, detail=f"Gemini {resp.status_code}: {resp.text}")

    data = resp.json()

    raw_text = None
    try:
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        raw_text = json.dumps(data)

    print("[ScrollSensay] raw_text:", repr(raw_text))
    parsed = parse_validation_response(raw_text)

    return {
        "score": float(parsed.get("score", 0.5)),
        "explanation": parsed.get("explanation") if isinstance(parsed.get("explanation"), list) else [parsed.get("explanation", "Unable to explain the outcome.")],
    }


@app.post("/api/verify", response_model=VerifyResponse)
async def verify(request: VerifyRequest):
    try:
        result = analyze_text(request.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result
