<?php
/**
 * Plugin Name: Language Converter Plugin
 * Description: Adds an English/French language switcher with flags, localized content fields, and EN/FR URL prefixes for inner pages.
 * Version: 1.0.0
 * Author: Nasir Saeed
 * License: GPL-2.0-or-later
 * Text Domain: language-converter-plugin
 */

if (!defined('ABSPATH')) {
    exit;
}

define('LCP_VERSION', '1.0.0');
define('LCP_PLUGIN_FILE', __FILE__);
define('LCP_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('LCP_PLUGIN_URL', plugin_dir_url(__FILE__));

require_once LCP_PLUGIN_DIR . 'includes/class-lcp-core.php';

function lcp_bootstrap() {
    LCP_Core::instance();
}
add_action('plugins_loaded', 'lcp_bootstrap');

