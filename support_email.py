#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Schoolify – Support Email Backend
---------------------------------
Dieses Modul stellt einen Flask-Endpoint bereit, der Support-E-Mails
über die Resend-API versendet. Der API-Key wird NICHT im Frontend
gespeichert, sondern ausschließlich hier auf dem Server.

Dieses Skript nutzt die BEREITS EXISTIERENDE config.py im Projekt.
Dort muss lediglich eine Variable RESEND_API_KEY ergänzt werden.

Voraussetzungen:
    pip install flask requests flask-cors

Starten:
    python support_email.py
"""

import os
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

# Versuche, die bestehende config.py zu importieren
try:
    import config
    print("[Support Email] Bestehende config.py gefunden.")
except ImportError:
    print("[Support Email] config.py nicht gefunden!", file=sys.stderr)
    sys.exit(1)

# Prüfe, ob RESEND_API_KEY in config.py existiert
if not hasattr(config, "RESEND_API_KEY"):
    print("[Support Email] RESEND_API_KEY fehlt in config.py!", file=sys.stderr)
    print("[Support Email] Bitte ergänze in config.py: RESEND_API_KEY = \"re_xxxx\"", file=sys.stderr)
    sys.exit(1)

API_KEY = config.RESEND_API_KEY

# Optional: Umgebungsvariable hat Vorrang
env_key = os.environ.get("RESEND_API_KEY")
if env_key:
    API_KEY = env_key.strip()
    print("[Support Email] Verwende RESEND_API_KEY aus Umgebungsvariable.")

app = Flask(__name__)
CORS(app)

# ========== KONFIGURATION ==========
RESEND_API_URL = "https://api.resend.com/emails"
DEFAULT_FROM = "Schoolify Support <support@schoolify.app>"
MAGIC_LINK_EXPIRY_DAYS = 7

def log_msg(msg):
    print(f"[Support Email] {msg}", file=sys.stderr)

def send_email(to_address, subject, html_content):
    """E-Mail über Resend versenden. Gibt True bei Erfolg zurück."""
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "from": DEFAULT_FROM,
        "to": [to_address],
        "subject": subject,
        "html": html_content
    }
    try:
        response = requests.post(RESEND_API_URL, json=payload, headers=headers, timeout=10)
        if response.status_code == 200:
            return True
        else:
            log_msg(f"Resend API Fehler {response.status_code}: {response.text}")
            return False
    except Exception as e:
        log_msg(f"Netzwerkfehler: {e}")
        return False

@app.route("/send-support-email", methods=["POST"])
def handle_support_email():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "error": "Keine JSON-Daten"}), 400

    to_address = data.get("to")
    original_message = data.get("original_message", "")
    response_text = data.get("response", "")
    magic_link = data.get("magic_link")  # optional

    if not to_address:
        return jsonify({"success": False, "error": "Empfänger fehlt"}), 400

    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:10px;">
      <h2 style="color:#3C4340;">Schoolify Support</h2>
      <p>Hallo,</p>
      <p>vielen Dank für deine Anfrage. Hier ist unsere Antwort:</p>
      <blockquote style="background:#f9f9f9;padding:15px;border-left:4px solid #B7E4D4;margin:15px 0;">
        {response_text}
      </blockquote>
      <p><strong>Deine ursprüngliche Nachricht:</strong></p>
      <p style="background:#f9f9f9;padding:10px;border-radius:5px;">{original_message}</p>
    """

    if magic_link:
        html += f"""
        <p>Du kannst dich mit einem Klick in deinen Account einloggen:</p>
        <p style="text-align:center;margin:20px 0;">
          <a href="{magic_link}" style="background:#B7E4D4;color:#3C4340;padding:10px 20px;border-radius:25px;text-decoration:none;font-weight:bold;">Jetzt einloggen</a>
        </p>
        <p style="font-size:0.8em;color:#888;">Dieser Link ist {MAGIC_LINK_EXPIRY_DAYS} Tage gültig und funktioniert nur einmal.</p>
        """

    html += """
      <p style="margin-top:30px;">Liebe Grüße,<br>Dein Schoolify-Team</p>
    </div>
    """

    success = send_email(to_address, "Antwort auf deine Support-Anfrage", html)
    if success:
        return jsonify({"success": True})
    else:
        return jsonify({"success": False, "error": "E-Mail-Versand fehlgeschlagen"}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Schoolify Support Email Server läuft auf http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port)
