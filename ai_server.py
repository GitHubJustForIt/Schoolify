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
        raise ValueError("Kein GROQ_API_KEY auf Render gesetzt.")

    # Entfernt mehrfache Leerzeichen/Zeilenumbrüche zur Token-Ersparnis
    clean_system = " ".join(SYSTEM_PROMPT.split())
    messages = [{"role": "system", "content": clean_system}]

    # Nur die allerletzten 2 Nachrichten (1 Frage + 1 Antwort, je max. 150 Zeichen)
    if history and isinstance(history, list):
        for msg in history[-2:]:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = str(msg["text"])[:150].strip()
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    # Aktueller Prompt (max. 300 Zeichen)
    messages.append({"role": "user", "content": str(user_prompt)[:300].strip()})

    client = Groq(api_key=API_KEY)
    completion = client.chat.completions.create(
        model="openai/gpt-oss-20b",
        messages=messages,
        temperature=0.3,
        max_completion_tokens=250,  # Kurze Antworten sparen extrem viele Tokens!
        reasoning_effort="low",
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
        log_error(f"Rate Limit: {e}")
        return jsonify({
            "error": "Limit von 8.000 Tokens/Minute erreicht. Bitte 30–60 Sekunden warten.",
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
