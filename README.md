# Consolidate Demodaten

Web-Anwendung, mit der Vertrieb und Consulting branchenspezifische Demodaten in eine Consolidate-Instanz schreiben.

## Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

`OPENAI_API_KEY` kann in `.env.local` stehen oder im Formular eingegeben werden. Optional setzt `OPENAI_MODEL` das Modell, Standard ist `gpt-4o-mini`.

Die Anmeldung verwendet Benutzername und Passwort der Instanz. Die Sitzung bleibt als Cookie auf diesem Server.
