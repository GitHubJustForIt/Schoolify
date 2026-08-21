import os
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS
from groq import Groq, RateLimitError, APIError
from config import SYSTEM_PROMPT

app = Flask(__name__)
CORS(app)

API_KEY = os.environ.get("GROQ_API_KEY")
MODEL_NAME = "openai/gpt-oss-20b"

def log_msg(msg):
    print(f"[Schoolify KI] {msg}", file=sys.stderr)

def ask_ai(user_prompt: str, history: list = None):
    if not API_KEY:
        raise ValueError("Kein GROQ_API_KEY auf Render gesetzt.")

    # 1. System-Prompt bereinigen & deckeln (schützt vor Error 400 & 413)
    clean_system = " ".join(SYSTEM_PROMPT.split())
    messages = [{"role": "system", "content": clean_system[:2200]}]

    # 2. Verlauf extrem schlank halten (max. 2 Nachrichten à 150 Zeichen)
    if history and isinstance(history, list):
        for msg in history[-2:]:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = str(msg["text"])[:150].strip()
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    # 3. Aktueller User-Prompt (max. 400 Zeichen)
    messages.append({"role": "user", "content": str(user_prompt)[:400].strip()})

    client = Groq(api_key=API_KEY)
    
    completion = client.chat.completions.create(
        model=MODEL_NAME,
        messages=messages,
        temperature=0.3,            # Niedrig = Strenge Charakter-Treue aus config.py
        max_completion_tokens=250,  # Spart massiv Tokens, um unter dem 8000 TPM Limit zu bleiben
        reasoning_effort="low",     # Reduziert verdeckte Denk-Tokens
        stream=False
    )
    return completion.choices[0].message.content

@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json()
    if not data or "prompt" not in data:
        return jsonify({"error": "Kein Prompt übermittelt"}), 400

    try:
        reply = ask_ai(data["prompt"], data.get("history", []))
        return jsonify({"reply": reply})
    except RateLimitError as e:
        log_msg(f"Rate Limit überschritten: {e}")
        return jsonify({
            "error": "Groq-Limit (8.000 TPM) erreicht. Bitte 20–30 Sekunden warten.",
            "code": 429
        }), 429
    except APIError as e:
        log_msg(f"Groq API Fehler: {e}")
        return jsonify({"error": f"Groq API-Fehler ({e.status_code}): {e.message}"}), 500
    except Exception as e:
        log_msg(f"Server-Fehler: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
