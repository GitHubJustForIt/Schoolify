import os
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
from config import SYSTEM_PROMPT, MODEL_NAME

app = Flask(__name__)
CORS(app)

API_KEY = os.environ.get("OPENROUTER_API_KEY")

def log_error(msg):
    """Schreibt Fehler in die Server-Konsole."""
    print(f"[Schoolify KI] FEHLER: {msg}", file=sys.stderr)

def ask_ai(user_prompt: str, history: list = None):
    """
    Sendet eine Anfrage an OpenRouter und gibt die Antwort zurück.
    Wirft bei Fehlern eine Exception, die von der Route behandelt wird.
    """
    if not API_KEY:
        log_error("Kein API_KEY auf Render gesetzt.")
        raise Exception("Kein API_KEY auf Render gesetzt.")

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    if history and isinstance(history, list):
        for msg in history:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = msg["text"]
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": MODEL_NAME,
        "messages": messages
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=15)
        if response.status_code == 200:
            data = response.json()
            return data["choices"][0]["message"]["content"]
        else:
            # Detaillierte Fehlermeldung mit Statuscode und Text
            error_text = response.text
            log_error(f"HTTP {response.status_code}: {error_text}")
            raise Exception(f"HTTP {response.status_code}: {error_text}")
    except requests.exceptions.Timeout:
        log_error("Timeout bei der Anfrage an OpenRouter.")
        raise Exception("Zeitüberschreitung bei der Anfrage an OpenRouter.")
    except Exception as e:
        # Falls schon eine Exception geworfen wurde, weiterreichen
        raise e

@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json()
    if not data or "prompt" not in data:
        log_error("Kein Prompt übermittelt.")
        return jsonify({"error": "Kein Prompt übermittelt"}), 400

    user_prompt = data["prompt"]
    history = data.get("history", [])

    try:
        reply = ask_ai(user_prompt, history)
        return jsonify({"reply": reply})
    except Exception as e:
        log_error(f"Fehler in /ask: {e}")
        # Wir geben einen echten HTTP-Fehlerstatus mit JSON-Fehlermeldung zurück.
        # Das Frontend erkennt nun zuverlässig, dass ein Fehler aufgetreten ist.
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
