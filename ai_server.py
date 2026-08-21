import os
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS
from groq import Groq, RateLimitError
from config import SYSTEM_PROMPT

app = Flask(__name__)
CORS(app)

API_KEY = os.environ.get("GROQ_API_KEY")

def log_error(msg):
    print(f"[Schoolify KI] FEHLER: {msg}", file=sys.stderr)

def ask_ai(user_prompt: str, history: list = None):
    if not API_KEY:
        log_error("Kein GROQ_API_KEY auf Render gesetzt.")
        raise Exception("Kein GROQ_API_KEY auf Render gesetzt.")

    # System-Prompt absichern
    safe_system_prompt = SYSTEM_PROMPT[:1500] if SYSTEM_PROMPT else "Du bist ein Schul-Assistent."
    messages = [{"role": "system", "content": safe_system_prompt}]

    # Genau die letzten 8 Nachrichten nehmen (= 4 Frage-Antwort-Paare)
    if history and isinstance(history, list):
        recent_history = history[-8:]
        for msg in recent_history:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                # Nachrichten im Verlauf moderat begrenzen, damit 8 Nachrichten sicher reinpassen
                text = str(msg["text"])[:600]
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    # Aktuelle Frage anhängen
    safe_user_prompt = str(user_prompt)[:1200]
    messages.append({"role": "user", "content": safe_user_prompt})

    try:
        client = Groq(api_key=API_KEY)
        completion = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=messages,
            temperature=0.7,
            max_completion_tokens=800,
            top_p=1,
            reasoning_effort="low",
            stream=False
        )
        return completion.choices[0].message.content

    except RateLimitError as e:
        log_error(f"Groq Rate Limit überschritten: {e}")
        raise e
    except Exception as e:
        log_error(f"Groq API Fehler: {e}")
        raise Exception(f"Fehler bei der Groq-Anfrage: {e}")

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
        return jsonify({"error": "Zu viele Anfragen auf einmal. Bitte kurz warten.", "code": 429}), 429
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
