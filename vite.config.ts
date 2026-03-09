import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        fs: {
            // Allow serving files from the home directory structure
            // Set MOHAA_BASE_PATH env var to override the default path
            allow: ['..', process.env.MOHAA_BASE_PATH || '/home/elgan/mohaa-web-base']
        }
    }
});
