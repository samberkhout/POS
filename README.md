# POS Systeem — Lokaal kassasysteem voor Raspberry Pi 5

Een compleet Point of Sale systeem met kassierscherm, keukenscherm, online bestelpagina via QR code, Adyen betaalintegratie en bonnenprinter. Draait volledig lokaal op een Raspberry Pi 5, met optionele publieke toegang via Cloudflare Tunnel voor online bestellingen.

## Hardware overzicht

| Component | Beschrijving |
|-----------|-------------|
| Raspberry Pi 5 | Server, draait Raspberry Pi OS Lite (geen desktop) |
| 2x Android tablet / iPad | Kassier- en keukenscherm via Fully Kiosk Browser of Guided Access |
| ESC/POS USB bonnenprinter | Thermische printer voor bonnen en keukentickets |
| Adyen Verifone P630 | Pinterminal met 4G simkaart |
| Kleine WiFi router | Lokaal netwerk voor alle apparaten |

## 1. Vereisten

- **Node.js 20** of hoger
- **npm** (wordt meegeleverd met Node.js)
- **Raspberry Pi OS Lite** (aanbevolen, geen desktop nodig)

### Node.js installeren op Raspberry Pi

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node --version  # Moet v20.x.x tonen
```

## 2. Installatie

```bash
# Clone of kopieer het project naar de Raspberry Pi
cd /home/pi
git clone <repository-url> pos-system
cd pos-system

# Installeer dependencies
npm install

# Kopieer de voorbeeldconfiguratie
cp .env.example .env

# Bewerk de configuratie
nano .env
```

## 3. Configuratie (.env)

Bewerk het `.env` bestand met je eigen waarden:

```env
# Server
PORT=3000
LOCAL_NETWORK_CIDR=192.168.1.0/24    # Je lokale netwerk range

# Adyen Terminal API (Pin betaling)
ADYEN_API_KEY=live_xxx...             # Adyen API key
ADYEN_MERCHANT_ACCOUNT=JouwAccount    # Merchant account naam
ADYEN_POIID=V400m-123456789          # Terminal serienummer (zie sectie 5)
ADYEN_ENVIRONMENT=live                # 'test' of 'live'

# Adyen Checkout API (Online betaling)
ADYEN_CHECKOUT_API_KEY=live_xxx...    # Kan dezelfde zijn als ADYEN_API_KEY
ADYEN_CHECKOUT_CLIENT_KEY=live_xxx... # Client key uit Adyen Dashboard
ADYEN_WEBHOOK_HMAC_KEY=xxx...        # HMAC key uit Adyen Dashboard

# Publieke URL
PUBLIC_URL=https://bestel.jouwdomein.nl

# Printer
PRINTER_DEVICE=/dev/usb/lp0
```

## 4. Database setup

De database wordt **automatisch aangemaakt** bij de eerste start. Er is geen handmatige setup nodig. De SQLite database wordt opgeslagen als `pos.db` in de projectmap.

**Standaard admin wachtwoord:** `admin` (wordt afgedwongen om te wijzigen bij eerste login)

## 5. Starten

```bash
# Eenmalig starten
node server.js

# Of met npm
npm start
```

De server draait op `http://localhost:3000` en toont:
```
POS server draait op poort 3000
  Kassier:   http://localhost:3000/cashier
  Keuken:    http://localhost:3000/kitchen
  Admin:     http://localhost:3000/admin
  Bestellen: http://localhost:3000/bestel
```

## 6. Adyen configuratie

### Test vs. Live modus

| Instelling | Test | Live |
|-----------|------|------|
| `ADYEN_ENVIRONMENT` | `test` | `live` |
| API key prefix | `test_` | `live_` |
| Client key prefix | `test_` | `live_` |
| Terminal endpoint | terminal-api-test.adyen.com | terminal-api-live.adyen.com |
| Checkout endpoint | checkout-test.adyen.com | checkout-live.adyen.com |

**Tip:** Gebruik eerst `test` modus om alles te testen met test kaartgegevens.

### POIID vinden (terminal serienummer)

Het POIID is het serienummer van je Adyen pinterminal:

1. Open het **Adyen Customer Area** (ca-live.adyen.com)
2. Ga naar **Point of Sale** → **Terminals**
3. Het POIID staat in de kolom **Terminal ID** (bijv. `V400m-123456789`)
4. Of kijk op de sticker achterop de terminal

### Webhook instellen

1. Ga naar **Adyen Customer Area** → **Developers** → **Webhooks**
2. Maak een nieuwe **Standard webhook** aan
3. URL: `https://bestel.jouwdomein.nl/adyen/webhook`
4. Kopieer de **HMAC Key** naar `ADYEN_WEBHOOK_HMAC_KEY` in `.env`
5. Activeer de webhook

## 7. Printer setup op Raspberry Pi 5

### USB printer aansluiten

```bash
# Controleer of de printer herkend wordt
ls /dev/usb/lp0

# Als het apparaat niet bestaat, laad de USB printer driver
sudo modprobe usblp

# Voeg je gebruiker toe aan de lp groep voor toegang
sudo usermod -a -G lp pi

# Log opnieuw in of herstart voor de groepswijziging
sudo reboot
```

### Printer testen

```bash
# Handmatige test: print tekst naar printer
echo "Test print" | sudo tee /dev/usb/lp0

# Via het admin paneel:
# Ga naar http://192.168.x.x:3000/admin → Instellingen → Test printer
```

### Als /dev/usb/lp0 niet bestaat

```bash
# Controleer aangesloten USB apparaten
lsusb

# Controleer kernel logs voor printer detectie
dmesg | grep -i printer
dmesg | grep -i usblp

# Laad de driver handmatig
sudo modprobe usblp

# Maak het permanent (overleeft herstart)
echo "usblp" | sudo tee -a /etc/modules
```

## 8. Autostart met PM2

PM2 zorgt ervoor dat de server automatisch start bij het opstarten van de Pi en herstart bij crashes.

```bash
# Installeer PM2 globaal
sudo npm install -g pm2

# Start de server met PM2
cd /home/pi/pos-system
pm2 start server.js --name pos

# Sla de huidige PM2 configuratie op
pm2 save

# Configureer PM2 om te starten bij boot
pm2 startup
# Voer het commando uit dat PM2 toont (begint met sudo env PATH=...)

# Controleer status
pm2 status
pm2 logs pos
```

### PM2 commando's

```bash
pm2 restart pos    # Herstart de server
pm2 stop pos       # Stop de server
pm2 logs pos       # Bekijk logs
pm2 monit          # Realtime monitoring
```

## 9. Cloudflare Tunnel setup

De Cloudflare Tunnel maakt de bestelpagina (`/bestel`) publiek toegankelijk zonder port forwarding.

### Installatie

```bash
# Installeer cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Login bij Cloudflare
cloudflared tunnel login

# Maak een nieuwe tunnel
cloudflared tunnel create pos-tunnel
```

### Configuratie

Maak het configuratiebestand aan:

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Inhoud van `config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: bestel.jouwdomein.nl
    service: http://localhost:3000
  - service: http_status:404
```

### DNS instellen

```bash
cloudflared tunnel route dns pos-tunnel bestel.jouwdomein.nl
```

### Autostart via systemd

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Status controleren
sudo systemctl status cloudflared
```

## 10. DNS migratie van Strato naar Cloudflare

Als je domein bij Strato geregistreerd is:

### Stap 1: Cloudflare account aanmaken
1. Ga naar [cloudflare.com](https://www.cloudflare.com) en maak een gratis account aan
2. Klik op **Add a Site** en voer je domein in (bijv. `jouwdomein.nl`)
3. Kies het **Free** plan

### Stap 2: Nameservers wijzigen bij Strato
1. Log in bij [strato.nl](https://www.strato.nl) → **Mijn Strato**
2. Ga naar **Domeinen** → **Domeininstellingen** → **Nameserver**
3. Wijzig de nameservers naar de Cloudflare nameservers (worden getoond in Cloudflare dashboard):
   - Bijv. `ada.ns.cloudflare.com`
   - Bijv. `bob.ns.cloudflare.com`
4. Sla op

### Stap 3: Wachten op propagatie
- Duurt meestal 1-24 uur
- Cloudflare stuurt een e-mail wanneer het actief is

### Stap 4: CNAME record aanmaken
1. Ga in Cloudflare naar **DNS** → **Records**
2. Voeg een nieuw **CNAME** record toe:
   - **Name:** `bestel`
   - **Target:** `<tunnel-id>.cfargotunnel.com`
   - **Proxy status:** Proxied (oranje wolk)

## 11. Fully Kiosk Browser setup (Android tablets)

Fully Kiosk Browser is een Android app die de tablet in kiosk modus zet, zodat personeel niet per ongeluk de app kan verlaten.

### Installatie

1. Download **Fully Kiosk Browser** uit de Google Play Store
2. Open de app en geef de gevraagde rechten

### Configuratie per tablet

**Kassier tablet:**
- Start URL: `http://192.168.x.x:3000/cashier`
  (vervang x.x door het IP-adres van de Raspberry Pi)

**Keuken tablet:**
- Start URL: `http://192.168.x.x:3000/kitchen`

### Kiosk modus instellingen

In Fully Kiosk Browser → Settings:

| Instelling | Waarde |
|-----------|--------|
| Start URL | `http://192.168.x.x:3000/cashier` of `/kitchen` |
| Enable Kiosk Mode | Aan |
| Hide Status Bar | Aan |
| Hide Navigation Bar | Aan |
| Screen Timeout | Nooit (0) |
| Autostart on Boot | Aan |
| Web Auto Reload on Disconnect | Aan |
| Web Auto Reload after (seconds) | 10 |
| Swipe to Navigate | Uit |
| Drag and Drop | Uit |

### iPad alternatief (Guided Access)

1. Ga naar **Instellingen** → **Toegankelijkheid** → **Begeleide toegang**
2. Schakel **Begeleide toegang** in
3. Stel een pincode in
4. Open Safari en ga naar `http://192.168.x.x:3000/cashier`
5. Druk 3x op de zijknop om Begeleide toegang te starten
6. Tik op **Start**

## 12. Schermen openen

| Scherm | URL | Toegang |
|--------|-----|---------|
| Kassier | `http://192.168.x.x:3000/cashier` | Alleen lokaal netwerk |
| Keuken | `http://192.168.x.x:3000/kitchen` | Alleen lokaal netwerk |
| Admin | `http://192.168.x.x:3000/admin` | Alleen lokaal netwerk |
| Bestelpagina | `https://bestel.jouwdomein.nl/bestel` | Publiek (via Cloudflare Tunnel) |

**IP-adres van de Raspberry Pi vinden:**
```bash
hostname -I
```

## 13. Beveiliging

- `/cashier`, `/kitchen` en `/admin` zijn **alleen bereikbaar via het lokale netwerk**
- Externe toegang via Cloudflare Tunnel wordt automatisch geblokkeerd voor deze routes
- Alleen `/bestel`, `/bedankt` en `/adyen/webhook` zijn publiek toegankelijk
- Admin paneel is beveiligd met een wachtwoord (bcrypt gehasht)
- Adyen webhooks worden geverifieerd met HMAC signatures

## 14. Troubleshooting

### Printer niet gevonden

```bash
# Controleer of /dev/usb/lp0 bestaat
ls -la /dev/usb/lp0

# Controleer USB verbinding
lsusb

# Herlaad USB printer driver
sudo modprobe usblp

# Controleer rechten
groups  # Moet 'lp' bevatten
```

### Adyen terminal reageert niet

1. Controleer of de terminal aanstaat (groen lampje)
2. Controleer 4G verbinding op het terminal scherm
3. Controleer of `ADYEN_POIID` correct is in `.env`
4. Controleer of `ADYEN_ENVIRONMENT` overeenkomt met je API key (`test_` of `live_`)
5. Probeer de terminal te herstarten

### Cloudflare Tunnel werkt niet

```bash
# Controleer tunnel status
sudo systemctl status cloudflared

# Bekijk tunnel logs
sudo journalctl -u cloudflared -f

# Herstart tunnel
sudo systemctl restart cloudflared

# Test handmatig
cloudflared tunnel run pos-tunnel
```

### Tablet verliest verbinding met server

1. Controleer of PM2 draait: `pm2 status`
2. Controleer of de server luistert: `curl http://localhost:3000`
3. Controleer WiFi verbinding van de tablet
4. Herstart de server: `pm2 restart pos`
5. In Fully Kiosk Browser: zorg dat "Web Auto Reload on Disconnect" aanstaat

### Scherm blijft leeg

1. **Browser cache legen:** In Fully Kiosk Browser → Settings → Advanced → Clear Cache
2. **Server herstarten:** `pm2 restart pos`
3. **Handmatig testen:** Open de URL in een gewone browser op een laptop
4. **Logs bekijken:** `pm2 logs pos`

### Server crasht

```bash
# Bekijk crash logs
pm2 logs pos --lines 50

# Controleer geheugengebruik
free -h

# Controleer schijfruimte (SQLite database kan groeien)
df -h
```
