<?php

if (!defined('ABSPATH')) {
    exit;
}

class LCP_Core {
    private static $instance = null;
    private $lang = 'en';

    public static function instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    private function __construct() {
        add_action('init', array($this, 'register_query_var'));
        add_action('init', array($this, 'register_rewrite_rules'));
        add_action('init', array($this, 'detect_language'), 20);

        // Ensure our custom rewrite tag is available as a public query var.
        add_filter('query_vars', array($this, 'register_query_vars'));

        add_action('wp_enqueue_scripts', array($this, 'enqueue_assets'));
        // Print early in the footer so the container exists before footer scripts run.
        add_action('wp_footer', array($this, 'render_google_translate_container'), 5);
        add_shortcode('lcp_language_switcher', array($this, 'shortcode_switcher'));
        add_action('wp_ajax_lcp_translate_text', array($this, 'ajax_translate_text'));
        add_action('wp_ajax_nopriv_lcp_translate_text', array($this, 'ajax_translate_text'));

        add_filter('body_class', array($this, 'body_class'));
        add_filter('page_link', array($this, 'filter_page_link'), 20, 2);

        register_activation_hook(LCP_PLUGIN_FILE, array(__CLASS__, 'activate'));
        register_deactivation_hook(LCP_PLUGIN_FILE, array(__CLASS__, 'deactivate'));
    }

    public static function activate() {
        $instance = self::instance();
        $instance->register_query_var();
        $instance->register_rewrite_rules();
        flush_rewrite_rules();
    }

    public static function deactivate() {
        flush_rewrite_rules();
    }

    public function register_query_var() {
        add_rewrite_tag('%lcp_lang%', '(en|fr)');
    }

    public function register_query_vars($vars) {
        if (!is_array($vars)) {
            $vars = array();
        }
        if (!in_array('lcp_lang', $vars, true)) {
            $vars[] = 'lcp_lang';
        }
        return $vars;
    }

    public function register_rewrite_rules() {
        add_rewrite_rule(
            '^(en|fr)/(.*)?$',
            'index.php?pagename=$matches[2]&lcp_lang=$matches[1]',
            'top'
        );
    }

    public function detect_language() {
        $lang = get_query_var('lcp_lang');
        $cookie_lang = isset($_COOKIE['lcp_lang']) ? sanitize_key(wp_unslash($_COOKIE['lcp_lang'])) : '';

        if (in_array($lang, array('en', 'fr'), true)) {
            $this->lang = $lang;
        } elseif (in_array($cookie_lang, array('en', 'fr'), true)) {
            $this->lang = $cookie_lang;
        } else {
            // If rewrites/query var are bypassed (some caching/page builder setups), detect from URL prefix.
            $request_uri = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '';
            $path = $request_uri ? wp_parse_url($request_uri, PHP_URL_PATH) : '';
            $path = is_string($path) ? $path : '';
            if (preg_match('#^/(en|fr)(/|$)#', $path, $m)) {
                $this->lang = $m[1];
            } else {
            // First-time default language.
            $this->lang = 'en';
            }
        }

        if (!headers_sent()) {
            $path = COOKIEPATH ? COOKIEPATH : '/';
            $domain = '';

            // Prefer WP cookie domain if defined, otherwise try to share between www/non-www.
            if (defined('COOKIE_DOMAIN') && COOKIE_DOMAIN) {
                $domain = COOKIE_DOMAIN;
            } else {
                $host = wp_parse_url(home_url('/'), PHP_URL_HOST);
                $host = is_string($host) ? $host : '';
                $host = preg_replace('/^www\./i', '', $host);
                if ($host && strpos($host, '.') !== false && filter_var($host, FILTER_VALIDATE_IP) === false) {
                    $domain = '.' . $host;
                }
            }

            setcookie('lcp_lang', $this->lang, time() + YEAR_IN_SECONDS, $path, $domain, is_ssl(), true);
        }
    }

    public function enqueue_assets() {
        wp_enqueue_style(
            'lcp-style',
            LCP_PLUGIN_URL . 'assets/css/lcp-style.css',
            array(),
            LCP_VERSION
        );

        wp_enqueue_script(
            'lcp-script',
            LCP_PLUGIN_URL . 'assets/js/lcp-switcher.js',
            array(),
            LCP_VERSION,
            true
        );

        wp_register_script(
            'lcp-google-translate',
            'https://translate.google.com/translate_a/element.js?cb=lcpGoogleTranslateInit',
            array(),
            null,
            true
        );

        $inline_init = "
            function lcpGoogleTranslateInit() {
                new google.translate.TranslateElement({
                    pageLanguage: 'en',
                    includedLanguages: 'en,fr',
                    autoDisplay: false,
                    layout: google.translate.TranslateElement.InlineLayout.SIMPLE
                }, 'lcp-google-translate-element');
            }
        ";
        wp_add_inline_script('lcp-google-translate', $inline_init, 'before');
        wp_enqueue_script('lcp-google-translate');

        wp_localize_script('lcp-script', 'lcpData', array(
            'switchUrls'  => array(
                'en' => $this->get_switch_url('en'),
                'fr' => $this->get_switch_url('fr'),
            ),
            'currentLang' => in_array($this->lang, array('en', 'fr'), true) ? $this->lang : 'en',
            'homePath'    => $this->get_home_path(),
            'ajaxUrl'     => admin_url('admin-ajax.php'),
            'nonce'       => wp_create_nonce('lcp_translate_nonce'),
        ));
    }

    public function ajax_translate_text() {
        $nonce = isset($_POST['nonce']) ? sanitize_text_field(wp_unslash($_POST['nonce'])) : '';
        if (!wp_verify_nonce($nonce, 'lcp_translate_nonce')) {
            wp_send_json_error(array('message' => 'Invalid nonce'), 403);
        }

        $text = isset($_POST['text']) ? wp_unslash($_POST['text']) : '';
        $text = is_string($text) ? trim($text) : '';
        if ($text === '') {
            wp_send_json_success(array('translated' => ''));
        }

        // Keep requests bounded to avoid timeouts/abuse.
        if (strlen($text) > 3000) {
            $text = substr($text, 0, 3000);
        }

        $translated = $this->translate_text_server($text, 'en', 'fr');
        if ($translated === '') {
            wp_send_json_success(array('translated' => $text));
        }

        wp_send_json_success(array('translated' => $translated));
    }

    private function translate_text_server($text, $from = 'en', $to = 'fr') {
        $url = add_query_arg(
            array(
                'q'        => $text,
                'langpair' => $from . '|' . $to,
            ),
            'https://api.mymemory.translated.net/get'
        );

        $response = wp_remote_get(
            $url,
            array(
                'timeout' => 15,
                'headers' => array(
                    'Accept' => 'application/json',
                ),
            )
        );

        if (is_wp_error($response)) {
            return '';
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status < 200 || $status >= 300) {
            return '';
        }

        $body = wp_remote_retrieve_body($response);
        if (!$body) {
            return '';
        }

        $data = json_decode($body, true);
        if (!is_array($data) || !isset($data['responseData']['translatedText'])) {
            return '';
        }

        $translated = (string) $data['responseData']['translatedText'];
        return trim($translated);
    }

    public function shortcode_switcher() {
        $en_url = $this->get_switch_url('en');
        $fr_url = $this->get_switch_url('fr');
        $current = in_array($this->lang, array('en', 'fr'), true) ? $this->lang : 'en';

        ob_start();
        ?>
        <div class="lcp-switcher" data-current-lang="<?php echo esc_attr($current); ?>" aria-label="Language Switcher">
            <button type="button" class="lcp-trigger" id="lcp-lang-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="<?php echo esc_attr__('Language', 'language-converter-plugin'); ?>">
                <span class="lcp-trigger-flag" id="lcp-current-flag"><?php echo $current === 'fr' ? '&#x1F1EB;&#x1F1F7;' : '&#x1F1FA;&#x1F1F8;'; ?></span>
            </button>

            <div class="lcp-menu" id="lcp-lang-menu" role="listbox" aria-labelledby="lcp-lang-trigger" hidden>
                <button type="button" class="lcp-item" data-lang="en" data-url="<?php echo esc_url($en_url); ?>" role="option" aria-selected="<?php echo $current === 'en' ? 'true' : 'false'; ?>">
                    <span class="lcp-flag">&#x1F1FA;&#x1F1F8;</span>
                </button>
                <button type="button" class="lcp-item" data-lang="fr" data-url="<?php echo esc_url($fr_url); ?>" role="option" aria-selected="<?php echo $current === 'fr' ? 'true' : 'false'; ?>">
                    <span class="lcp-flag">&#x1F1EB;&#x1F1F7;</span>
                </button>
            </div>
        </div>
        <?php

        return (string) ob_get_clean();
    }

    public function render_google_translate_container() {
        if (is_admin()) {
            return;
        }

        // Always print this once per page so Google Translate can initialize even if the
        // header switcher shortcode isn't present on a given template.
        echo '<div id="lcp-google-translate-element" class="lcp-google-element" aria-hidden="true"></div>';
    }

    public function body_class($classes) {
        $classes[] = 'lcp-lang-' . $this->lang;
        return $classes;
    }

    public function filter_page_link($link, $post_id) {
        if (is_admin()) {
            return $link;
        }

        if ((int) get_option('page_on_front') === (int) $post_id) {
            return trailingslashit(home_url('/'));
        }

        return $this->prefix_link_if_needed($link);
    }

    private function prefix_link_if_needed($url) {
        if (!in_array($this->lang, array('en', 'fr'), true)) {
            return $url;
        }

        $relative_path = $this->normalize_relative_path_from_url($url);
        if ($relative_path === '/') {
            return trailingslashit(home_url('/'));
        }

        return home_url('/' . $this->lang . $relative_path);
    }

    private function get_switch_url($target_lang) {
        if (!in_array($target_lang, array('en', 'fr'), true)) {
            return home_url('/');
        }

        $path = $this->get_request_relative_path();
        if ($path === '/') {
            return home_url('/');
        }

        return home_url('/' . $target_lang . $path);
    }

    private function get_request_relative_path() {
        $request_uri = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '/';
        $path = wp_parse_url($request_uri, PHP_URL_PATH);
        if (!$path) {
            return '/';
        }

        return $this->normalize_relative_path($path);
    }

    private function normalize_relative_path_from_url($url) {
        $path = wp_parse_url($url, PHP_URL_PATH);
        if (!$path) {
            return '/';
        }

        return $this->normalize_relative_path($path);
    }

    private function normalize_relative_path($path) {
        $path = '/' . ltrim((string) $path, '/');

        $home_path = $this->get_home_path();

        if ($home_path !== '/' && strpos($path, $home_path) === 0) {
            $path = substr($path, strlen($home_path));
            $path = $path === false || $path === '' ? '/' : $path;
            $path = '/' . ltrim($path, '/');
        }

        $path = preg_replace('#^/(en|fr)(/|$)#', '/', $path);
        $path = '/' . trim((string) $path, '/');

        return $path === '/' ? '/' : '/' . trim($path, '/') . '/';
    }

    private function get_home_path() {
        $home_path = wp_parse_url(home_url('/'), PHP_URL_PATH);
        $home_path = $home_path ? '/' . trim((string) $home_path, '/') : '/';
        return $home_path === '/' ? '/' : trailingslashit($home_path);
    }

}
