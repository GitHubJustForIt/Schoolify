import os
from flask import Flask, request, jsonify
import requests
from config import SYSTEM_PROMPT, MODEL_NAME

app = Flask(__name__)

# WICHTIG: API-Key NICHT im Code, sondern als Umgebungsvariable auf Render setzen!
API_KEY = os.environ.get("OPENROUTER_API_KEY")

def ask_ai(user_prompt: str):
    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt}
        ]
    }
    try:
        response = requests.post(url, headers=headers, json=payload)
        if response.status_code == 200:
            data = response.json()
            return data["choices"][0]["message"]["content"]
        else:
            return f"Fehler {response.status_code}: {response.text}"
    except Exception as e:
        return f"Ein Fehler ist aufgetreten: {e}"

@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json()
    if not data or "prompt" not in data:
        return jsonify({"error": "Kein Prompt übermittelt"}), 400
    user_prompt = data["prompt"]
    reply = ask_ai(user_prompt)
    return jsonify({"reply": reply})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
