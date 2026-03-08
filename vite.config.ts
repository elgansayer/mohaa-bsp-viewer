import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        fs: {
            // Allow serving files from the home directory structure
            allow: ['..', '/home/elgan/mohaa-web-base']
        }
    }
});
