// PM2 Configuratie voor Bureau Max Quiz
module.exports = {
  apps: [{
    name: 'bureau-max-quiz',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    }
  }]
};
