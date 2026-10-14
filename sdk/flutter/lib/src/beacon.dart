import 'dart:math';

/// Builds the JSON body for `POST /api/collect`. Pure functions, no I/O — fully unit-testable.
///
/// Wire format (shared with the web tracker, plus the app-only fields):
///   d   site domain              p   path / screen name
///   n   event name (optional)    pr  event properties (flat, scalars only)
///   pf  platform: android|ios|macos|windows|linux
///   av  app version              dv  mobile|tablet|desktop
///   l   language (de-AT)         cc  2-letter region of the device locale
///   sid random per-launch id (never persisted, never a device id)
///   s / um / uc  utm source / medium / campaign (e.g. from a deep link)
class TacilyticsBeacon {
  TacilyticsBeacon._();

  static const _sidChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  /// A fresh random session id: 24 chars, cryptographically random. Lives only in memory.
  static String newSessionId([Random? rnd]) {
    final r = rnd ?? Random.secure();
    return List.generate(24, (_) => _sidChars[r.nextInt(_sidChars.length)]).join();
  }

  /// Normalises a screen name into a path: `ProductPage` stays, `product/42` → `/product/42`.
  static String path(String screen) {
    var p = screen.trim();
    if (p.isEmpty) return '/';
    if (!p.startsWith('/')) p = '/$p';
    if (p.length > 1 && p.endsWith('/')) p = p.substring(0, p.length - 1);
    return p.length > 512 ? p.substring(0, 512) : p;
  }

  /// Properties are flat key → scalar. Nested values and nulls are dropped, max 12 keys,
  /// everything stringified — the same rules the server enforces, so nothing is silently lost twice.
  static Map<String, String>? props(Map<String, Object?>? raw) {
    if (raw == null || raw.isEmpty) return null;
    final out = <String, String>{};
    for (final e in raw.entries) {
      if (out.length >= 12) break;
      final v = e.value;
      if (v == null || v is Map || v is Iterable) continue;
      final k = e.key.trim();
      if (k.isEmpty) continue;
      final s = v is double ? _num(v) : v.toString();
      out[k.length > 40 ? k.substring(0, 40) : k] = s.length > 80 ? s.substring(0, 80) : s;
    }
    return out.isEmpty ? null : out;
  }

  static String _num(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2);

  static Map<String, Object> build({
    required String domain,
    required String platform,
    required String sessionId,
    required String screen,
    String? name,
    Map<String, Object?>? properties,
    String? appVersion,
    String? device,
    String? language,
    String? region,
    String? utmSource,
    String? utmMedium,
    String? utmCampaign,
  }) {
    final body = <String, Object>{
      'd': domain,
      'p': path(screen),
      'pf': platform,
      'sid': sessionId,
    };
    if (name != null && name.trim().isNotEmpty) {
      body['n'] = name.trim();
      final pr = props(properties);
      if (pr != null) body['pr'] = pr;
    }
    if (appVersion != null && appVersion.isNotEmpty) body['av'] = appVersion;
    if (device != null) body['dv'] = device;
    if (language != null && language.isNotEmpty) body['l'] = language;
    if (region != null && RegExp(r'^[A-Za-z]{2}$').hasMatch(region)) body['cc'] = region.toUpperCase();
    if (utmSource != null && utmSource.isNotEmpty) body['s'] = utmSource;
    if (utmMedium != null && utmMedium.isNotEmpty) body['um'] = utmMedium;
    if (utmCampaign != null && utmCampaign.isNotEmpty) body['uc'] = utmCampaign;
    return body;
  }
}
