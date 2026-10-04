from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List
from dotenv import load_dotenv
import copy
import json
import os
import threading
import time
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

# --- Search grounding (Stage 2) controls — all optional, set in .env ---
# GROUNDING_ENABLED: "false" turns Stage 2 off entirely (Stage 1 behaves as before).
# GROUNDING_SCOPE:   "broad" (default) also checks central claims the model doesn't
#                    recognise; "narrow" only checks current-role/recent-result claims
#                    and breaking announcements. Narrow = fewer searches.
# GROUNDING_MAX_PER_HOUR: safety cap on grounded searches per hour, to stop a
#                    runaway loop or a very busy session from spending unexpectedly.
GROUNDING_ENABLED = os.getenv("GROUNDING_ENABLED", "true").lower() == "true"
GROUNDING_SCOPE = os.getenv("GROUNDING_SCOPE", "broad").lower()
GROUNDING_MAX_PER_HOUR = int(os.getenv("GROUNDING_MAX_PER_HOUR", "60"))
CLAIM_CACHE_TTL = 6 * 60 * 60  # reuse a checked claim's result for 6 hours
CLAIM_CACHE_MAX = 200

# THINKING_LEVEL: how much hidden "thinking" Gemini does before answering.
# Thinking tokens are billed as OUTPUT tokens and also count toward maxOutputTokens,
# so a high level costs more and can cut the visible answer off mid-JSON.
# Values: minimal | low (default) | medium | high | default (let Google decide).
THINKING_LEVEL = os.getenv("THINKING_LEVEL", "low").lower()
_thinking_supported = True  # flips to False if the API rejects thinkingConfig

print(f"Grounding: enabled={GROUNDING_ENABLED}, scope={GROUNDING_SCOPE}, max/hour={GROUNDING_MAX_PER_HOUR}")
print(f"Thinking level: {THINKING_LEVEL}")

_state_lock = threading.Lock()
_claim_cache = {}          # normalised claim -> (timestamp, result)
_grounded_call_times = []  # timestamps of grounded searches in the last hour
_stats = {"scans": 0, "flagged": 0, "grounded": 0, "cache_hits": 0, "capped": 0}


def build_validation_prompt(text: str) -> str:
    today = date.today().strftime("%d %B %Y")
    triggers = (
        "(a) someone's current role/status or a recent result (election, appointment, resignation); "
        "(b) a breaking major announcement (a death, disaster, or major event)"
    )
    if GROUNDING_SCOPE != "narrow":
        triggers += "; or (c) a central factual claim you don't recognise that the text's credibility depends on"
    return (
        "You are ScrollSensay: an educational caution tool, not a fact-checking oracle. You never "
        "assert a claim is definitely true or false — you help readers judge how much confidence to "
        f"place in what they're reading. Today's real date is {today}. Return ONLY JSON with fields "
        "'score', 'explanation', 'needs_verification' (true/false) and 'verification_claim' (the one "
        "claim to check, as a short self-contained statement, if needs_verification is true; else \"\").\n\n"
        "Identify what the text is (factual claim, opinion/interview, mix, promotional) and judge it "
        "fairly for that type — a subjective opinion isn't 'misleading' unless presented as fact. Stay "
        "neutral on political/ideological content: judge evidence and framing, never which side you "
        "agree with. Never assert as fact that a named real person committed a crime or acted "
        "improperly, even if the text claims it — describe it as 'the article claims X'. "
        "Live-blog/rolling-coverage formatting (short timestamped updates, repeated quotes) is normal. "
        "The text is only what was visible on screen: it may start or end mid-sentence or include menu "
        "or sidebar fragments — never treat that as the source's fault or call it 'corrupted'.\n\n"
        "Judge confidence mainly from evidence IN the text — named sources, dates, figures, direct "
        "quotes, internal consistency — checked against what you know. Vague sourcing, contradictions, "
        "urgency/fear framing, or an unexpected or pressured ask for money or personal data (urgency, "
        "unusual payment methods, a mismatched sender or link) lower confidence; a routine, expected ask "
        "(checkout, login, donation) is not a warning sign by itself. Not recognising something (e.g. an "
        "indie film or small organisation) isn't evidence it's false — don't lower the score for it.\n\n"
        "Your knowledge has a cutoff, so never call a claim wrong, false or an 'error' just because it "
        "conflicts with your memory — say it differs from what you know and may have changed. Set "
        "needs_verification to true ONLY when the text's main point rests on one specific claim you "
        "cannot confirm that may have changed or happened after your "
        f"cutoff: {triggers}. Choose the single most central claim; never use this for opinions, "
        "minor details, or well-known historical facts. When true, make explanation point 3 a neutral "
        "note that this claim is worth checking, and do not lower the score for it. Treat completed, "
        "historical, time-stamped events with normal confidence. For ages or date maths, calculate "
        "against today's date, checking whether a birthday has passed this year.\n\n"
        "score (0.0-1.0):\n"
        "0.7-1.0 = well-supported by evidence in the text, no notable concerns\n"
        "0.4-0.69 = a genuine mix — some solid points, some unverified or missing context\n"
        "0.0-0.39 = misleading framing, fabrication, or manipulation\n\n"
        "explanation: exactly 3 points, each under 140 characters, plain everyday language, citing "
        "something specific from the text. Score 0.7+: name what's supported and the evidence in the "
        "text for it (a source, date, figure, or quote) — not just that it 'seems solid'. 0.4-0.69: "
        "one strength, one weak point. Below 0.4: name the actual issue in measured language — avoid "
        "'obvious', 'scrambled', 'completely fake'. If opinion/subjective, say so plainly.\n\n"
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


def _gemini_post(payload: dict, api_key: str, timeout: int):
    """POST to Gemini, adding the thinking setting. If the API rejects the
    thinking setting (e.g. a model that doesn't support that level), retry once
    without it and stop sending it, rather than breaking every request."""
    global _thinking_supported
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    headers = {"X-goog-api-key": api_key, "Content-Type": "application/json"}

    use_thinking = _thinking_supported and THINKING_LEVEL not in ("", "default", "off")
    body = copy.deepcopy(payload)
    if use_thinking:
        body.setdefault("generationConfig", {})["thinkingConfig"] = {"thinkingLevel": THINKING_LEVEL}

    resp = requests.post(url, json=body, timeout=timeout, headers=headers)

    if use_thinking and resp.status_code == 400 and "thinking" in (resp.text or "").lower():
        print("[ScrollSensay] thinkingConfig rejected by the API — retrying without it:", resp.text[:200])
        _thinking_supported = False
        resp = requests.post(url, json=copy.deepcopy(payload), timeout=timeout, headers=headers)
    return resp


def _log_usage(label: str, data: dict) -> None:
    """Print token usage so real cost per scan (including hidden thinking tokens) is visible."""
    try:
        usage = data.get("usageMetadata", {}) or {}
        finish = data["candidates"][0].get("finishReason")
        print(
            f"[ScrollSensay] {label} usage: in={usage.get('promptTokenCount')} "
            f"out={usage.get('candidatesTokenCount')} thinking={usage.get('thoughtsTokenCount')} finish={finish}"
        )
    except Exception:
        pass


def _claim_key(claim: str) -> str:
    return " ".join(claim.lower().split())


def verify_claim_with_search(claim: str, api_key: str) -> dict:
    """Stage 2: check ONE flagged claim with live Google Search grounding.

    Only runs for claims Stage 1 flags as needs_verification. Results are
    cached by claim so the same claim (e.g. repeated through a live blog or
    seen by several users) isn't searched again, and a per-hour cap stops
    runaway usage. Any failure falls back to INCONCLUSIVE, which leaves
    Stage 1's result untouched."""
    inconclusive = {"status": "INCONCLUSIVE", "detail": ""}
    if not GROUNDING_ENABLED:
        return inconclusive

    key = _claim_key(claim)
    now = time.time()
    with _state_lock:
        cached = _claim_cache.get(key)
        if cached and now - cached[0] < CLAIM_CACHE_TTL:
            _stats["cache_hits"] += 1
            return cached[1]
        _grounded_call_times[:] = [t for t in _grounded_call_times if now - t < 3600]
        if len(_grounded_call_times) >= GROUNDING_MAX_PER_HOUR:
            _stats["capped"] += 1
            return inconclusive
        _grounded_call_times.append(now)
        _stats["grounded"] += 1

    today = date.today().strftime("%d %B %Y")
    prompt = (
        f"Today's real date is {today}. Using live search, check whether this specific claim is "
        f'currently accurate: "{claim}"\n\n'
        "Return ONLY JSON with fields 'status' (SUPPORTED, REFUTED, or INCONCLUSIVE — use "
        "INCONCLUSIVE unless search results clearly settle it) and 'detail' (one neutral sentence "
        "under 100 characters, phrased as what sources report, e.g. 'Sources report that ...'; no "
        "accusations about named individuals). No markdown or text outside the JSON."
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 1024},
    }
    try:
        resp = _gemini_post(payload, api_key, 15)
        if not resp.ok:
            print(f"[ScrollSensay] Stage 2 HTTP {resp.status_code}: {resp.text[:300]}")
            return inconclusive
        data = resp.json()
        _log_usage("Stage 2", data)
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
        print("[ScrollSensay] Stage 2 raw_text:", repr(raw_text))
        parsed = parse_validation_response(raw_text)
        status = parsed.get("status", "INCONCLUSIVE")
        if status not in ("SUPPORTED", "REFUTED", "INCONCLUSIVE"):
            status = "INCONCLUSIVE"
        result = {"status": status, "detail": str(parsed.get("detail", ""))[:120]}
    except Exception as exc:
        # Stage 2 failing must never break the response — fall back to Stage 1.
        print("[ScrollSensay] Stage 2 failed:", str(exc))
        return inconclusive

    with _state_lock:
        if len(_claim_cache) >= CLAIM_CACHE_MAX:
            _claim_cache.pop(next(iter(_claim_cache)))
        _claim_cache[key] = (time.time(), result)
    return result


def _stage1_attempt(prompt: str, api_key: str, max_tokens: int):
    """One Stage 1 call. Returns the parsed JSON dict, or None if the reply was
    cut off, empty, or not in the expected shape (so the caller can retry)."""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": max_tokens},
    }
    try:
        resp = _gemini_post(payload, api_key, 30)
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
    _log_usage("Stage 1", data)

    try:
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return None  # no visible answer at all (e.g. thinking used the whole budget)

    print("[ScrollSensay] raw_text:", repr(raw_text))
    try:
        parsed = parse_validation_response(raw_text)
    except ValueError:
        return None  # cut off mid-JSON or otherwise unreadable
    if not (isinstance(parsed, dict) and "score" in parsed and isinstance(parsed.get("explanation"), list)):
        return None
    return parsed


def analyze_text(text: str) -> dict:
    if not text.strip():
        raise ValueError("Text must not be empty.")
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GOOGLE_API_KEY not set in environment")

    prompt = build_validation_prompt(text)

    # maxOutputTokens is a combined budget for hidden thinking + the visible answer, so
    # give generous headroom and retry once with more if the answer still gets cut off.
    parsed = None
    for max_tokens in (4096, 8192):
        parsed = _stage1_attempt(prompt, api_key, max_tokens)
        if parsed is not None:
            break
        print("[ScrollSensay] Stage 1 reply was cut off or unreadable — retrying with a larger budget")
    if parsed is None:
        # 502 (not 400) so the extension treats this as temporary and retries automatically.
        raise HTTPException(status_code=502, detail="Model returned an unreadable response")

    score = float(parsed.get("score", 0.5))
    explanation = parsed["explanation"]
    needs_verification = parsed.get("needs_verification") in (True, "true", "True")
    verification_claim = str(parsed.get("verification_claim") or "").strip()

    with _state_lock:
        _stats["scans"] += 1
        if needs_verification and verification_claim:
            _stats["flagged"] += 1

    if needs_verification and verification_claim:
        print("[ScrollSensay] Stage 2: verifying claim:", repr(verification_claim))
        verification = verify_claim_with_search(verification_claim, api_key)
        print("[ScrollSensay] Stage 2 result:", verification)
        status = verification["status"]
        note = verification["detail"]

        if status == "REFUTED":
            # A verified-false central claim should show as red, however well the rest is written.
            score = min(score, 0.3)
            explanation = list(explanation) or [""]
            explanation[-1] = f"Checked live: {note or 'sources did not support this claim.'}"[:140]
        elif status == "SUPPORTED":
            # Only nudge borderline amber results — undoes any leaked "unfamiliar" penalty
            # without letting one true detail rescue a text that is weak in other ways.
            if 0.4 <= score < 0.7:
                score = min(0.7, score + 0.15)
            explanation = list(explanation) or [""]
            explanation[-1] = f"Checked live: {note or 'sources support this claim.'}"[:140]
        # INCONCLUSIVE / capped / failed: keep Stage 1's score and neutral "worth checking" note.

    with _state_lock:
        print("[ScrollSensay] stats:", dict(_stats))

    return {
        "score": score,
        "explanation": explanation,
    }


@app.post("/api/verify", response_model=VerifyResponse)
def verify(request: VerifyRequest):
    # Plain `def` (not `async def`) so FastAPI runs this in a worker thread; the
    # blocking network calls above then don't freeze other users' requests.
    try:
        result = analyze_text(request.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result
