<?php
/**
 * StackMate WordPress Plugin & Theme Licensing Reference Client
 *
 * Drop-in PHP helper for WordPress plugins (`wordpress_plugin`) and themes (`wordpress_theme`)
 * to activate, validate, deactivate, and verify Ed25519 offline grace entitlement tokens
 * against StackMate's `/api/v1/licenses/*` API.
 */

if (!defined('ABSPATH')) {
    // Allow standalone CLI verification in non-WP environments
}

class StackMate_WP_License_Client {
    private string $api_base_url;
    private string $product_slug;
    private string $plugin_version;

    public function __construct(string $api_base_url, string $product_slug, string $plugin_version = '1.0.0') {
        $this->api_base_url   = rtrim($api_base_url, '/');
        $this->product_slug   = $product_slug;
        $this->plugin_version = $plugin_version;
    }

    /**
     * Normalize the current WordPress site URL into a canonical domain identifier.
     */
    public function get_instance_identifier(string $site_url): string {
        $parsed = parse_url(strtolower(trim($site_url)));
        $host   = $parsed['host'] ?? $site_url;
        $path   = isset($parsed['path']) ? rtrim($parsed['path'], '/') : '';
        return $host . $path;
    }

    /**
     * Activate a license key on the current WordPress installation.
     */
    public function activate(string $license_key, string $site_url, string $environment = 'production', array $meta = []): array {
        return $this->request('/api/v1/licenses/activate', [
            'license_key'         => trim($license_key),
            'product_slug'        => $this->product_slug,
            'instance_identifier' => $this->get_instance_identifier($site_url),
            'instance_type'       => 'wordpress_site',
            'environment'         => $environment,
            'client_version'      => $this->plugin_version,
            'php_version'         => PHP_VERSION,
            'wp_version'          => $meta['wp_version'] ?? '6.7',
        ]);
    }

    /**
     * Validate an active license heartbeat and refresh the signed Ed25519 entitlement token.
     */
    public function validate(string $license_key, string $site_url, string $environment = 'production'): array {
        return $this->request('/api/v1/licenses/validate', [
            'license_key'         => trim($license_key),
            'product_slug'        => $this->product_slug,
            'instance_identifier' => $this->get_instance_identifier($site_url),
            'environment'         => $environment,
            'client_version'      => $this->plugin_version,
        ]);
    }

    /**
     * Deactivate the current WordPress installation to free an activation seat.
     */
    public function deactivate(string $license_key, string $site_url, string $environment = 'production'): array {
        return $this->request('/api/v1/licenses/deactivate', [
            'license_key'         => trim($license_key),
            'product_slug'        => $this->product_slug,
            'instance_identifier' => $this->get_instance_identifier($site_url),
            'environment'         => $environment,
        ]);
    }

    private function request(string $path, array $body): array {
        $url     = $this->api_base_url . $path;
        $payload = json_encode($body);
        $ch      = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Accept: application/json',
                'User-Agent: StackMate-WP-Client/' . $this->plugin_version,
            ],
        ]);
        $response = curl_exec($ch);
        $status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $decoded = is_string($response) ? json_decode($response, true) : null;
        return [
            'http_status' => $status,
            'body'        => $decoded,
        ];
    }
}
