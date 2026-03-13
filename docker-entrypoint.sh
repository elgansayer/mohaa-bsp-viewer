#!/bin/sh
# Generate runtime config from environment variables
cat > /usr/share/nginx/html/config.js <<EOF
window.__CONFIG__ = {
    PK3_BASE_URL: "${PK3_BASE_URL:-https://cdn.moh-central.net/main}"
};
EOF

exec nginx -g 'daemon off;'
