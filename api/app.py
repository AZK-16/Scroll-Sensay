from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List
from dotenv import load_dotenv
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

app = FastAPI(title="ScrollSensay API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# ---------------------------------------------------------------- settings
# Only VERIFY_MODEL and GOOGLE_API_KEY are needed. The rest are optional .env overrides.
MODEL_NAME = os.getenv("VERIFY_MODEL", "gemini-3.6-flash")
GROUNDING_ENABLED = os.getenv("GROUNDING_ENABLED", "true").lower() == "true"  # "false" = never search
MAX_SCANS_PER_HOUR = int(os.getenv("MAX_SCANS_PER_HOUR", "600"))       # spend ceiling (0 = no limit)
MAX_SEARCHES_PER_HOUR = int(os.getenv("MAX_SEARCHES_PER_HOUR", "60"))  # search ceiling (0 = no limit)

# Hidden "thinking" is billed as output and shares the maxOutputTokens budget, so keep it low.
THINKING_LEVEL = "low"  # minimal | low | medium | high

# Estimate only (USD per token, Gemini 3.x Flash through 31 Dec 2026) — for the cost shown in the log.
PRICE_IN, PRICE_OUT, USD_TO_GBP = 0.75 / 1e6, 3.75 / 1e6, 0.75

print(f"Model: {MODEL_NAME} | grounding: {GROUNDING_ENABLED} | limits/hour: "
      f"{MAX_SCANS_PER_HOUR} scans, {MAX_SEARCHES_PER_HOUR} searches")

_lock = threading.Lock()
_recent = {"scan": [], "search": []}  # timestamps in the last hour, for the two limits
_session_usd = 0.0                    # running cost estimate since the server started


def _within_limit(kind: str, limit: int) -> bool:
    """True (and records it) if fewer than `limit` of this kind happened in the last hour."""
    if limit <= 0:
        return True
    now = time.time()
    with _lock:
        _recent[kind] = [t for t in _recent[kind] if now - t < 3600]
        if len(_recent[kind]) >= limit:
            return False
        _recent[kind].append(now)
        return True


def _same_claim(a: str, b: str) -> bool:
    """True only if two claims are identical apart from case and punctuation (no fuzzy matching)."""
    norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum())
    return bool(a) and bool(b) and norm(a) == norm(b)


# ------------------------------------------------------------------ prompt
def build_validation_prompt(text: str) -> str:
    today = date.today().strftime("%d %B %Y")
    return (
        "You are ScrollSensay: an educational caution tool, not a fact-checking oracle. You never "
        "assert a claim is definitely true or false — you help readers judge how much confidence to "
        f"place in what they're reading. Today's real date is {today}. Return ONLY JSON with fields "
        "'score', 'explanation', 'needs_verification' (true/false), 'verification_claim' and "
        "'clash_claim'. Each claim is a short self-contained statement in plain minimal form — no "
        "titles, ages or extra detail, e.g. \"Jane Doe is the CEO of Acme\" — or \"\" if not used.\n\n"
        "Identify what the text is (factual claim, opinion/interview, mix, promotional) and judge it "
        "fairly for that type — a subjective opinion isn't 'misleading' unless presented as fact. Stay "
        "neutral on political/ideological content: judge evidence and framing, never which side you "
        "agree with. Never assert as fact that a named real person committed a crime or acted "
        "improperly, even if the text claims it — describe it as 'the article claims X'. "
        "Live-blog/rolling-coverage formatting (short timestamped updates, repeated quotes) is normal. "
        "The text is only what was visible on screen: it may start or end mid-sentence or include menu "
        "or sidebar fragments — never treat that as the source's fault or call it 'corrupted'. Judge "
        "and check only the main piece the page is about: ignore menu, sidebar, trending, related-"
        "article and advert fragments, and never choose a claim from them.\n\n"
        "Judge confidence mainly from evidence IN the text — named sources, dates, figures, direct "
        "quotes, internal consistency — checked against what you know. Vague sourcing, contradictions, "
        "urgency/fear framing, or an unexpected or pressured ask for money or personal data (urgency, "
        "unusual payment methods, a mismatched sender or link) lower confidence; a routine, expected ask "
        "(checkout, login, donation) is not a warning sign by itself. Not recognising something (e.g. an "
        "indie film or small organisation) isn't evidence it's false — don't lower the score for it.\n\n"
        "Your knowledge has a cutoff, and out-of-date knowledge feels like certainty (e.g. 'X is the "
        "Prime Minister' may simply be newer than what you know). So a clash with your memory is NOT "
        "evidence: never criticise it, call it a mistake, or let it lower the score (noting what "
        "matches your knowledge is fine). Instead use two optional slots, each one specific, checkable "
        "claim on any topic — never an opinion, minor detail or well-known historical fact: "
        "(1) needs_verification=true with verification_claim: the one claim you cannot confirm that "
        "matters most to trusting the text; (2) clash_claim: the one claim that conflicts with your "
        "memory. If slot (1) is used, make explanation point 3 a neutral note that this claim is "
        "worth checking; if slot (2) is used, make point 2 the same kind of neutral note — a plain "
        "'worth checking', not a verdict. Don't lower the score for either. Treat completed, "
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
    if text.startswith("```"):  # strip markdown code fences
        text = text.split("\n", 1)[-1]
        text = text.rsplit("```", 1)[0].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1 and start < end:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
        raise ValueError("Unable to parse JSON from model response.")


# ------------------------------------------------------------ Gemini calls
def _generate(prompt: str, max_tokens: int, tally: dict, search: bool = False, timeout: int = 30):
    """One Gemini call. Returns the reply text (None if there was no visible answer).
    Raises HTTPException for HTTP-level problems; a 429 keeps its Retry-After."""
    global _session_usd
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": max_tokens,
            "thinkingConfig": {"thinkingLevel": THINKING_LEVEL},
        },
    }
    if search:
        payload["tools"] = [{"google_search": {}}]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
    headers = {"X-goog-api-key": os.getenv("GOOGLE_API_KEY", ""), "Content-Type": "application/json"}

    try:
        resp = requests.post(url, json=payload, timeout=timeout, headers=headers)
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
    usage = data.get("usageMetadata") or {}
    cost = (usage.get("promptTokenCount") or 0) * PRICE_IN + (
        (usage.get("candidatesTokenCount") or 0) + (usage.get("thoughtsTokenCount") or 0)) * PRICE_OUT
    tally["usd"] += cost
    with _lock:
        _session_usd += cost

    candidate = (data.get("candidates") or [{}])[0]
    if candidate.get("finishReason") not in (None, "STOP"):
        print(f"[ScrollSensay] Warning: Gemini reply ended with {candidate.get('finishReason')}")
    parts = (candidate.get("content") or {}).get("parts") or []
    return parts[0].get("text") if parts else None


def _parse_scan(reply):
    """Stage 1 reply -> dict with a numeric score and a non-empty explanation list, else None."""
    if not reply:
        return None
    try:
        parsed = parse_validation_response(reply)
    except ValueError:
        return None
    if (isinstance(parsed, dict) and isinstance(parsed.get("score"), (int, float))
            and isinstance(parsed.get("explanation"), list) and parsed["explanation"]):
        return parsed
    return None


def _live_check(claims: list, tally: dict) -> list:
    """Stage 2: check one or two claims with ONE live Google Search call.
    Returns a (status, detail) pair per claim, in order. Any problem (off, over the limit,
    error, unreadable) -> INCONCLUSIVE for every claim, so Stage 1's result stands."""
    unknown = [("INCONCLUSIVE", "")] * len(claims)
    if not GROUNDING_ENABLED:
        return unknown
    if not _within_limit("search", MAX_SEARCHES_PER_HOUR):
        print("[ScrollSensay] search limit reached — skipping live check")
        return unknown
    today = date.today().strftime("%d %B %Y")
    listing = "\n".join(f'{i}. "{c}"' for i, c in enumerate(claims, 1))
    prompt = (
        f"Today's real date is {today}. Using live search, check whether each of these claims is "
        f"currently accurate:\n{listing}\n\n"
        "Return ONLY JSON: {\"results\": [...]} with one object per claim, in the same order, each "
        "with 'status' (SUPPORTED, REFUTED, or INCONCLUSIVE — use INCONCLUSIVE unless search results "
        "clearly settle it) and 'detail' (one neutral sentence under 100 characters, phrased as what "
        "sources report, e.g. 'Sources report that ...'; no accusations about named individuals). "
        "No markdown or text outside the JSON."
    )
    try:
        data = parse_validation_response(_generate(prompt, 1024, tally, search=True, timeout=20) or "")
        items = data if isinstance(data, list) else data.get("results")
        if not isinstance(items, list):
            items = [data]  # tolerate a single bare object
        results = []
        for i in range(len(claims)):
            item = items[i] if i < len(items) and isinstance(items[i], dict) else {}
            status = item.get("status")
            if status not in ("SUPPORTED", "REFUTED", "INCONCLUSIVE"):
                status = "INCONCLUSIVE"
            results.append((status, str(item.get("detail", ""))[:120]))
        return results
    except Exception as exc:  # includes HTTP errors: a failed live check must never break a scan
        print("[ScrollSensay] live check failed:", exc)
        return unknown


# -------------------------------------------------------------------- scan
def analyze_text(text: str) -> dict:
    if not text.strip():
        raise ValueError("Text must not be empty.")
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(status_code=500, detail="GOOGLE_API_KEY not set in environment")
    if not _within_limit("scan", MAX_SCANS_PER_HOUR):
        raise HTTPException(status_code=429, detail="Hourly scan limit reached", headers={"Retry-After": "60"})

    prompt = build_validation_prompt(text)
    tally = {"usd": 0.0}

    # Stage 1: the evaluation. Thinking shares the token budget with the answer, so if the
    # reply is cut off or unreadable, try once more with more room.
    parsed = None
    for max_tokens in (4096, 8192):
        reply = _generate(prompt, max_tokens, tally)
        print("[ScrollSensay] raw_text:", repr(reply))
        parsed = _parse_scan(reply)
        if parsed:
            break
        print("[ScrollSensay] reply was cut off or unreadable — retrying with a larger budget")
    if not parsed:
        # 502 (not 400) so the extension treats this as temporary and retries by itself.
        raise HTTPException(status_code=502, detail="Model returned an unreadable response")

    score = float(parsed["score"])
    explanation = [str(p) for p in parsed["explanation"]]

    # Stage 2: live search for up to TWO claims in ONE call. "weak point" = the claim Stage 1 can't
    # confirm that matters most; "clash" = a claim that conflicts with its memory. Out-of-date
    # knowledge feels like certainty, so a clash is checked rather than criticised.
    flagged = parsed.get("needs_verification") in (True, "true", "True")
    weak = str(parsed.get("verification_claim") or "").strip() if flagged else ""
    clash = str(parsed.get("clash_claim") or "").strip()
    if _same_claim(clash, weak):
        clash = ""
    slots = []  # (label, explanation point to replace, claim)
    if weak:
        slots.append(("weak point", 2, weak))
    if clash:
        slots.append(("clash", 1, clash))

    check = "none"
    if slots:
        results = _live_check([claim for _, _, claim in slots], tally)
        verdicts = []
        for (label, point, _), (status, detail) in zip(slots, results):
            verdicts.append(f"{label}: {status}")
            if status in ("SUPPORTED", "REFUTED"):
                fallback = "sources support this claim." if status == "SUPPORTED" else "sources did not support this claim."
                explanation[min(point, len(explanation) - 1)] = f"Checked live: {detail or fallback}"[:140]
        check = ", ".join(verdicts)
        statuses = [status for status, _ in results]
        if "REFUTED" in statuses:
            score = min(score, 0.3)  # a verified-false claim shows as red, however well the rest is written
        elif "SUPPORTED" in statuses and 0.4 <= score < 0.7:
            score = min(0.7, score + 0.15)  # nudge borderline amber only; never rescue a weak text

    level = "green" if score >= 0.7 else "amber" if score >= 0.4 else "red"
    with _lock:
        session = _session_usd
    print(f"[ScrollSensay] SCAN {level} {score:.2f} | live check: {check} | "
          f"this scan ~{tally['usd'] * USD_TO_GBP * 100:.2f}p | session ~£{session * USD_TO_GBP:.3f}")

    return {"score": score, "explanation": explanation}


@app.post("/api/verify", response_model=VerifyResponse)
def verify(request: VerifyRequest):
    # Plain `def` (not `async def`): FastAPI runs it in a worker thread, so one slow Gemini
    # call doesn't freeze other users' requests.
    try:
        return analyze_text(request.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
