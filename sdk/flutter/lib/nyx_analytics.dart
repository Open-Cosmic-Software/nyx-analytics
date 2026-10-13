/// Nyx Analytics for Flutter 🦞 — privacy-first, cookieless app analytics.
///
/// ```dart
/// NyxAnalytics.init(endpoint: 'https://analytics.example.com', domain: 'example.com');
/// NyxAnalytics.instance.setEnabled(userConsented);   // nothing is sent before this
/// NyxAnalytics.instance.screen('/product/42');
/// NyxAnalytics.instance.purchase(value: 49.90, currency: 'EUR');
/// ```
library nyx_analytics;

export 'src/client.dart';
export 'src/beacon.dart';
