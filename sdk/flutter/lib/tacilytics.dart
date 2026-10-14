/// Tacilytics for Flutter — privacy-first, cookieless app analytics.
/// (tacit: we count, we don't tell.)
///
/// ```dart
/// Tacilytics.init(endpoint: 'https://analytics.example.com', domain: 'example.com');
/// Tacilytics.instance.setEnabled(userConsented);   // nothing is sent before this
/// Tacilytics.instance.screen('/product/42');
/// Tacilytics.instance.purchase(value: 49.90, currency: 'EUR');
/// ```
library tacilytics;

export 'src/client.dart';
export 'src/beacon.dart';
