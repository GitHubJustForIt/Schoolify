import os
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS
from groq import Groq, RateLimitError, APIError
from config import SYSTEM_PROMPT

app = Flask(__name__)
CORS(app)

API_KEY = os.environ.get("GROQ_API_KEY")

def log_error(msg):
    print(f"[Schoolify KI] FEHLER: {msg}", file=sys.stderr)

def ask_ai(user_prompt: str, history: list = None):
    if not API_KEY:
        raise ValueError("Kein GROQ_API_KEY in den Environment Variables gesetzt.")

    # 1. System-Prompt VOLLSTÄNDIG aus config.py laden
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # 2. Die letzten 6 Nachrichten aus der Chat-Historie anhängen
    if history and isinstance(history, list):
        for msg in history[-6:]:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = str(msg["text"])[:400].strip()
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    # 3. Aktueller User-Prompt
    messages.append({"role": "user", "content": str(user_prompt)[:1000].strip()})

    client = Groq(api_key=API_KEY)
    
    # Auf llama-3.1-8b-instant wechseln (auf allen Groq-Accounts verfügbar + 30.000 TPM Limit)
    completion = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=messages,
        temperature=0.7,
        max_completion_tokens=600,
        top_p=1,
        stream=False
    )
    return completion.choices[0].message.content

@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json()
    if not data or "prompt" not in data:
        return jsonify({"error": "Kein Prompt übermittelt"}), 400

    user_prompt = data["prompt"]
    history = data.get("history", [])

    try:
        reply = ask_ai(user_prompt, history)
        return jsonify({"reply": reply})
    except RateLimitError as e:
        log_error(f"Rate Limit: {e}")
        return jsonify({
            "error": "Zu viele Anfragen in kurzer Zeit. Bitte 10 Sekunden warten.",
            "code": 429
        }), 429
    except APIError as e:
        log_error(f"Groq API Fehler: {e}")
        return jsonify({"error": f"Groq API-Fehler: {e.message}"}), 500
    except Exception as e:
        log_error(f"Server-Fehler: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
