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
    print(f"[Schoolify KI] {msg}", file=sys.stderr)

def get_best_model(client):
    """Ermittelt automatisch die exakte Modell-ID auf deinem Groq-Account."""
    try:
        models_data = client.models.list()
        available_ids = [m.id for m in models_data.data]
        log_error(f"Verfügbare Groq-Modelle: {available_ids}")

        # 1. Bevorzuge Llama 3.3 / Llama 3 (kein Reasoning-Ballast, hält Charakter aus config.py)
        for m_id in available_ids:
            if "llama" in m_id.lower():
                return m_id

        # 2. Fallback auf GPT OSS
        for m_id in available_ids:
            if "gpt-oss-20b" in m_id.lower():
                return m_id

        return available_ids[0] if available_ids else "openai/gpt-oss-20b"
    except Exception as e:
        log_error(f"Konnte Modellliste nicht dynamisch abfragen: {e}")
        return "openai/gpt-oss-20b"

def ask_ai(user_prompt: str, history: list = None):
    if not API_KEY:
        raise ValueError("Kein GROQ_API_KEY in den Environment Variables auf Render gesetzt.")

    client = Groq(api_key=API_KEY)
    model_name = get_best_model(client)
    log_error(f"Aktuell gewähltes Modell: {model_name}")

    # System-Prompt aus config.py ungekürzt einbinden
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Chatverlauf (letzte 4 Nachrichten)
    if history and isinstance(history, list):
        for msg in history[-4:]:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = str(msg["text"])[:300].strip()
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    messages.append({"role": "user", "content": str(user_prompt)[:600].strip()})

    # Parameter dynamisch an den Modelltyp anpassen
    params = {
        "model": model_name,
        "messages": messages,
        "temperature": 0.5,
        "max_completion_tokens": 500,
        "stream": False
    }
    
    # reasoning_effort nur setzen, wenn ein GPT-OSS Modell gewählt wurde
    if "gpt-oss" in model_name.lower():
        params["reasoning_effort"] = "low"

    completion = client.chat.completions.create(**params)
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
            "error": "Token-Limit überschritten. Bitte kurz 20 Sekunden warten.",
            "code": 429
        }), 429
    except APIError as e:
        log_error(f"Groq API Fehler: {e}")
        return jsonify({"error": f"Groq API-Fehler ({e.status_code}): {e.message}"}), 500
    except Exception as e:
        log_error(f"Server-Fehler: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
