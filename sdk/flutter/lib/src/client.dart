import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

import 'beacon.dart';

/// The client. One instance per app; call [Tacilytics.init] once at start-up.
///
/// Privacy by design:
/// * **Off until you call [setEnabled]`(true)`** — wire it to your consent banner.
/// * No device id, no advertising id, no cookies. A random session id is drawn per app
///   launch, kept in memory only, and the server hashes it with a daily salt.
/// * Region comes from the device locale, never from IP geolocation.
/// * Fire-and-forget: tracking never throws into your app and never blocks the UI.
class Tacilytics {
  Tacilytics._(this.endpoint, this.domain, this.appVersion, this._client, this._platform);

  static Tacilytics? _instance;

  /// The configured client. Throws if [init] was not called.
  static Tacilytics get instance {
    final i = _instance;
    if (i == null) throw StateError('Tacilytics.init() must be called first');
    return i;
  }

  /// Configure once. [endpoint] is your Tacilytics server URL, [domain] the site as registered there
  /// (use the same one as your website to see web + app side by side, filterable by platform).
  static Tacilytics init({
    required String endpoint,
    required String domain,
    String? appVersion,
    bool enabled = false,
    http.Client? client,
    String? platformOverride,
  }) {
    final base = endpoint.endsWith('/') ? endpoint.substring(0, endpoint.length - 1) : endpoint;
    final i = Tacilytics._(base, domain, appVersion, client ?? http.Client(), platformOverride ?? _detectPlatform());
    i._enabled = enabled;
    _instance = i;
    return i;
  }

  final String endpoint;
  final String domain;
  final String? appVersion;
  final http.Client _client;
  final String? _platform;
  final String _sid = TacilyticsBeacon.newSessionId();
  bool _enabled = false;
  String? _lastScreen;
  String? _utmSource, _utmMedium, _utmCampaign;

  bool get enabled => _enabled;

  /// Turn tracking on/off, e.g. from your consent dialog. Off = nothing leaves the device.
  void setEnabled(bool on) => _enabled = on;

  /// Attribute this launch to a campaign (e.g. read from a deep link's utm_* parameters).
  void setCampaign({String? source, String? medium, String? campaign}) {
    _utmSource = source;
    _utmMedium = medium;
    _utmCampaign = campaign;
  }

  /// A screen view — the app equivalent of a pageview.
  Future<void> screen(String name) {
    _lastScreen = TacilyticsBeacon.path(name);
    return _send(screen: name);
  }

  /// A custom event / goal, attached to the current screen.
  Future<void> event(String name, [Map<String, Object?>? properties]) =>
      _send(screen: _lastScreen ?? '/', name: name, properties: properties);

  /// A completed order. Shows up in the revenue panels (by source and by platform).
  /// Never pass customer data or order numbers.
  Future<void> purchase({required double value, String currency = 'EUR', double? net, int? items}) =>
      event('Purchase', {
        'value': value,
        'currency': currency,
        if (net != null) 'net': net,
        if (items != null) 'items': items,
      });

  /// An in-app search with its result count (0 shows up under "No results").
  Future<void> search(String query, int results) => event('Search', {'q': query, 'results': results});

  Future<void> _send({required String screen, String? name, Map<String, Object?>? properties}) async {
    final pf = _platform;
    if (!_enabled || pf == null) return; // web builds: use the tacilytics.js tracker instead
    final locale = PlatformDispatcher.instance.locale;
    final body = TacilyticsBeacon.build(
      domain: domain,
      platform: pf,
      sessionId: _sid,
      screen: screen,
      name: name,
      properties: properties,
      appVersion: appVersion,
      device: _deviceClass(),
      language: locale.toLanguageTag(),
      region: locale.countryCode,
      utmSource: _utmSource,
      utmMedium: _utmMedium,
      utmCampaign: _utmCampaign,
    );
    try {
      await _client
          .post(
            Uri.parse('$endpoint/api/collect'),
            headers: {'Content-Type': 'application/json', 'User-Agent': 'Tacilytics-Flutter/0.2 ($pf)'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      // analytics must never break the app — a lost beacon is acceptable
    }
  }

  static String? _detectPlatform() {
    if (kIsWeb) return null;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'android';
      case TargetPlatform.iOS:
        return 'ios';
      case TargetPlatform.macOS:
        return 'macos';
      case TargetPlatform.windows:
        return 'windows';
      case TargetPlatform.linux:
        return 'linux';
      default:
        return null;
    }
  }

  /// Phone vs. tablet from the logical screen size (shortest side ≥ 600 dp = tablet).
  static String _deviceClass() {
    final views = PlatformDispatcher.instance.views;
    if (views.isEmpty) return 'mobile';
    final v = views.first;
    final size = v.physicalSize / v.devicePixelRatio;
    final pf = defaultTargetPlatform;
    if (pf == TargetPlatform.macOS || pf == TargetPlatform.windows || pf == TargetPlatform.linux) return 'desktop';
    return size.shortestSide >= 600 ? 'tablet' : 'mobile';
  }
}

/// Optional: track screen views automatically —
/// `MaterialApp(navigatorObservers: [TacilyticsRouteObserver()])`.
/// Uses the route's `settings.name`; unnamed routes (dialogs, sheets) are skipped.
class TacilyticsRouteObserver extends NavigatorObserver {
  TacilyticsRouteObserver({this.nameOf});

  /// Map a route to a screen name, e.g. to strip ids. Return null to skip the route.
  final String? Function(Route<dynamic> route)? nameOf;

  void _track(Route<dynamic>? route) {
    if (route == null || Tacilytics._instance == null) return;
    final name = nameOf != null ? nameOf!(route) : route.settings.name;
    if (name != null && name.isNotEmpty) Tacilytics.instance.screen(name);
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _track(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _track(newRoute);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _track(previousRoute);
}
