// ignore_for_file: deprecated_member_use_from_same_package
import 'package:flutter_test/flutter_test.dart';
import 'package:tacilytics/nyx_analytics.dart';

void main() {
  test('old Nyx names still work after the rename', () async {
    final c = NyxAnalytics.init(endpoint: 'http://127.0.0.1:9', domain: 'x.com', platformOverride: 'android');
    expect(identical(c, Tacilytics.instance), isTrue);
    expect(NyxBeacon.path('home'), '/home');
    expect(NyxRouteObserver(), isA<TacilyticsRouteObserver>());
    await c.screen('/home'); // disabled by default → returns quietly
  });
}
