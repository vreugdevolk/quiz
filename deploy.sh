#!/bin/bash
# Deploy script voor Bureau Max Quiz
# Gebruik: ./deploy.sh

set -e

echo "🎯 Bureau Max Quiz - Deployment"
echo "================================"

# Kleuren voor output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check of we op de server zijn
if [ ! -f "server.js" ]; then
    echo "❌ Fout: Voer dit script uit vanuit de quiz directory"
    exit 1
fi

# 1. Dependencies installeren
echo -e "${YELLOW}📦 Dependencies installeren...${NC}"
npm install --production

# 2. PM2 installeren indien nodig
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}📦 PM2 installeren...${NC}"
    npm install -g pm2
fi

# 3. App starten/herstarten met PM2
echo -e "${YELLOW}🚀 App starten met PM2...${NC}"
pm2 delete bureau-max-quiz 2>/dev/null || true
pm2 start ecosystem.config.js

# 4. PM2 opslaan voor auto-restart
pm2 save

# 5. Startup script genereren (eenmalig)
echo -e "${YELLOW}⚙️  Startup configureren...${NC}"
pm2 startup 2>/dev/null || true

echo ""
echo -e "${GREEN}✅ Deployment voltooid!${NC}"
echo ""
echo "De quiz draait nu op http://localhost:3001"
echo ""
echo "Volgende stappen voor productie:"
echo "1. Kopieer nginx.conf naar /etc/nginx/sites-available/quiz"
echo "2. Pas het domein aan in de nginx config"
echo "3. Activeer: ln -s /etc/nginx/sites-available/quiz /etc/nginx/sites-enabled/"
echo "4. Test: nginx -t"
echo "5. Herlaad: systemctl reload nginx"
echo "6. SSL: certbot --nginx -d quiz.yourdomain.com"
echo ""
echo "Handige PM2 commando's:"
echo "  pm2 status        - Status bekijken"
echo "  pm2 logs          - Logs bekijken"
echo "  pm2 restart all   - Herstarten"
