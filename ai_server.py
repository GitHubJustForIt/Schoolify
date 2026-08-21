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

    # 1. System-Prompt verstärken & auf max. 2500 Zeichen deckeln
    reinforced_system = (
        f"{SYSTEM_PROMPT}\n\n"
        "WICHTIG: Halte dich ausnahmslos an deine Rolle, deine Persönlichkeit und deinen Sprachstil!"
    )
    messages = [{"role": "system", "content": reinforced_system[:2500]}]

    # 2. Letzte 6 Nachrichten einbinden (max. 350 Zeichen pro Nachricht)
    if history and isinstance(history, list):
        recent_history = history[-6:]
        for msg in recent_history:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = str(msg["text"])[:350]
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    # 3. Aktuelle Anfrage (max. 700 Zeichen)
    messages.append({"role": "user", "content": str(user_prompt)[:700]})

    try:
        client = Groq(api_key=API_KEY)
        completion = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=messages,
            temperature=0.5,
            max_completion_tokens=500,  # Schützt das Minuten-Limit (TPM) vor Überlastung
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
        return jsonify({"error": "Zu viele Anfragen in einer Minute. Bitte 20 Sekunden warten.", "code": 429}), 429
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
