from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List
from dotenv import load_dotenv
import json
import os
import requests
from requests.exceptions import RequestException
from datetime import date

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

MODEL_NAME = os.getenv("VERIFY_MODEL", "gemini-3.6-flash")
print("Using model:", MODEL_NAME)

def build_validation_prompt(text: str) -> str:
    today = date.today().strftime("%d %B %Y")
    return (
        "You are ScrollSensay: an educational caution tool, not a fact-checking oracle. You never "
        "assert a claim is definitely true or false — you help readers judge how much confidence to "
        f"place in what they're reading. Today's real date is {today}. Return ONLY JSON with fields "
        "'score' and 'explanation'.\n\n"
        "Identify what the text is (factual claim, opinion/interview, mix, promotional) and judge it "
        "fairly for that type — a subjective opinion isn't 'misleading' unless presented as fact. Stay "
        "neutral on political/ideological content: judge evidence and framing, never which side you "
        "agree with. Never assert as fact that a named real person committed a crime or acted "
        "improperly, even if the text claims it — describe it as 'the article claims X', not as "
        "settled fact. Live-blog/rolling-coverage formatting (short timestamped updates, repeated "
        "quotes) is normal, not a sign of tampering.\n\n"
        "Your training data has a cutoff, so you can't know about changes after that point — but "
        "this matters only for claims about someone's CURRENT role or status, stated as true right "
        "now (e.g. 'is the Prime Minister', 'is the CEO'). For these specific claims only, if they "
        "conflict with your memory, don't call them false — note briefly that roles can change and "
        "it's worth confirming, without spending a whole explanation point on it unless central to "
        "the text. Treat completed, historical, or time-stamped events (something that happened, was "
        "announced, or was true as of a stated date) with normal confidence — this caution does not "
        "apply to them. For ages or date maths, calculate carefully against today's date above, "
        "checking whether a birthday has passed this year, rather than assuming.\n\n"
        "score (0.0-1.0):\n"
        "0.7-1.0 = well-supported, no notable concerns\n"
        "0.4-0.69 = a genuine mix — some solid points, some unverified or missing context\n"
        "0.0-0.39 = signs of misleading framing, fabrication, or manipulation\n\n"
        "explanation: exactly 3 points, each under 140 characters, plain everyday language referencing "
        "something specific in the text, not generic. Score 0.7+: name what's accurate. 0.4-0.69: name "
        "one strength and one weak point. Below 0.4: name the actual issue in measured language — "
        "avoid words like 'obvious', 'scrambled', 'completely fake'. If opinion/subjective, say so "
        "plainly rather than judging it as fact.\n\n"
        "No markdown or text outside the JSON.\n"
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
