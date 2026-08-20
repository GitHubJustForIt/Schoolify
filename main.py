import requests
from config import SYSTEM_PROMPT, MODEL_NAME

# Dein OpenRouter API-Key
API_KEY = "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"

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

# Hier startest du die Anfrage
if __name__ == "__main__":
    # DEIN PROMPT: Hier trägst du einfach deine Frage/Anforderung ein
    prompt = "Schreibe eine Python-Funktion, die testet, ob ein Wort ein Palindrom ist."
    
    print(f"Sende Frage an Modell {MODEL_NAME}...\n")
    antwort = ask_ai(prompt)
    
    print("--- Antwort der AI ---")
    print(antwort)
