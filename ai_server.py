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
        log_error("Kein GROQ_API_KEY auf Render gesetzt.")
        raise ValueError("Kein GROQ_API_KEY in den Environment Variables gesetzt.")

    # Unnötige Umbrüche & Leerzeichen aus config.py entfernen, um Tokens zu sparen
    clean_system = " ".join(SYSTEM_PROMPT.split())
    messages = [{"role": "system", "content": clean_system}]

    # Max. 4 alte Nachrichten (Verlauf) mit je max. 200 Zeichen
    if history and isinstance(history, list):
        for msg in history[-4:]:
            if isinstance(msg, dict) and "role" in msg and "text" in msg:
                role = msg["role"]
                text = str(msg["text"])[:200].strip()
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": text})

    # Aktueller User-Prompt (max. 400 Zeichen)
    messages.append({"role": "user", "content": str(user_prompt)[:400].strip()})

    client = Groq(api_key=API_KEY)
    completion = client.chat.completions.create(
        model="openai/gpt-oss-20b",
        messages=messages,
        temperature=0.3,
        max_completion_tokens=300,
        reasoning_effort="low",
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
        log_error(f"Rate-Limit / TPM überschritten: {e}")
        return jsonify({
            "error": "Groq Token-Limit (8000 TPM) überschritten. Bitte 30 Sekunden warten.",
            "code": 429
        }), 429
    except APIError as e:
        log_error(f"Groq API Error: {e}")
        return jsonify({"error": f"Groq API-Fehler: {e.message}"}), 500
    except Exception as e:
        log_error(f"Interner Server-Fehler: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
