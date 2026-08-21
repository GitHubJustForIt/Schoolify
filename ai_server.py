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

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Verlauf strikt auf die letzten 4 Nachrichten kürzen
    if history and isinstance(history, list):
        recent_history = history[-4:]
        for msg in recent_history:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = msg["text"]
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    messages.append({"role": "user", "content": user_prompt})

    try:
        client = Groq(api_key=API_KEY)
        completion = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=messages,
            temperature=0.7,
            max_completion_tokens=1024,
            top_p=1,
            reasoning_effort="low",  # Hält den Token-Verbrauch im Rahmen
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
        log_error("Kein Prompt übermittelt.")
        return jsonify({"error": "Kein Prompt übermittelt"}), 400

    user_prompt = data["prompt"]
    history = data.get("history", [])

    try:
        reply = ask_ai(user_prompt, history)
        return jsonify({"reply": reply})
    except RateLimitError as e:
        log_error(f"Rate-Limit-Fehler: {e}")
        return jsonify({"error": "Zu viele Anfragen auf einmal. Bitte kurz warten.", "code": 429}), 429
    except Exception as e:
        log_error(f"Fehler in /ask: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
