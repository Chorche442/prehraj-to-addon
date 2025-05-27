# Stremio Addon: Prehraj.to

Tento addon umožňuje streamovat obsah z webu https://prehraj.to přímo ve Stremiu.

## ⚙️ Krok za krokem: nasazení na Render

### 1. Připrav si GitHub repozitář

1. Rozbal tento ZIP.
2. Vytvoř nový veřejný repozitář na GitHubu (např. `stremio-prehrajto`).
3. Nahraj všechny soubory kromě `.env`.

### 2. Nastav `.env`

Vytvoř soubor `.env` lokálně (už je obsažen v ZIPu):

```
TMDB_KEY=TVUJ_API_KLIC
```

Necommituješ ho do Gitu.

### 3. Vytvoř hosting na Render.com

1. Jdi na [https://render.com](https://render.com)
2. Klikni „New → Web Service“
3. Vyber GitHub repozitář
4. Nastav:
   - Environment: **Node**
   - Build command: `npm install`
   - Start command: `node server.js`
5. V sekci „Environment Variables“ přidej:
   ```
   Key: TMDB_KEY
   Value: TVUJ_API_KLIC
   ```

6. Klikni „Create Web Service“

### 4. Použití ve Stremiu

1. Otevři Stremio
2. Přejdi do **Add-ons > Community Add-ons > Install via URL**
3. Vlož:
```
https://tvuj-addon.onrender.com/manifest.json
```

Hotovo ✅
