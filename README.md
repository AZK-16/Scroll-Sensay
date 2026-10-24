# ScrollSensay

ScrollSensay watches the content in your viewport as you browse and flags potentially misleading or untrustworthy text in real time. Powered by Google Gemini, it uses a traffic-light indicator based on the result:

- 🟢 Green, quite reliable 😊
- 🟡 Amber, worth a second look 🤔
- 🔴 Red, some concerns here 😧

## How it works

1. As you scroll, ScrollSensay reads the visible text on the page
2. It sends the text to a local AI backend for analysis
3. The dot and emoji in the corner changes based on the result
4. Click the dot to see a breakdown of what was flagged and why

## Project structure

```
ScrollSensay/
├── extension/
│   ├── content.js        # Reads viewport text, shows indicator dot and panel
│   ├── styles.css        # Indicator and panel styles
│   ├── popup.html/js     # Extension popup for configuring the API endpoint
│   ├── background.js     # Service worker
│   └── manifest.json     # Chrome extension manifest
├── api/
│   ├── app.py            # FastAPI backend (sends text to Gemini, returns score + explanation)
│   ├── requirements.txt  # Python dependencies
│   └── test_app.py
├── .env.example
└── .gitignore
```

## Setup

### 1. Backend

Copy `.env.example` to `.env` and fill in your values, then install dependencies and start the server:

```bash
cd api
python -m venv venv
source venv/bin/activate   # macOS / Linux
venv\Scripts\activate      # Windows

pip install -r requirements.txt
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

### 2. Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder
4. Click the ScrollSensay extension icon and set to Active

## API

### POST /api/verify

**Request:**
```json
{ "text": "Text to analyse" }
```

**Response:**
```json
{
  "score": 0.2,
  "explanation": ["Point one", "Point two", "Point three"]
}
```

`score` is 0.0–1.0, which the extension maps to green (≥0.7), amber (0.4–0.69), or red (<0.4).

