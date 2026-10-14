import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:tacilytics/tacilytics.dart';

void main() {
  test('screen names become paths', () {
    expect(TacilyticsBeacon.path('product/42'), '/product/42');
    expect(TacilyticsBeacon.path('/cart/'), '/cart');
    expect(TacilyticsBeacon.path('  '), '/');
  });

  test('session id is random, 24 url-safe chars', () {
    final a = TacilyticsBeacon.newSessionId(Random(1)), b = TacilyticsBeacon.newSessionId(Random(2));
    expect(a.length, 24);
    expect(RegExp(r'^[A-Za-z0-9]+$').hasMatch(a), isTrue);
    expect(a, isNot(b));
  });

  test('properties are flat scalars, nested and null dropped', () {
    final p = TacilyticsBeacon.props({'value': 49.9, 'items': 2, 'whole': 10.0, 'nested': {'a': 1}, 'list': [1], 'none': null});
    expect(p, {'value': '49.90', 'items': '2', 'whole': '10'});
  });

  test('build: pageview has no event fields, event carries props', () {
    final pv = TacilyticsBeacon.build(domain: 'x.com', platform: 'android', sessionId: 's' * 24, screen: 'home', region: 'at');
    expect(pv['p'], '/home');
    expect(pv['cc'], 'AT');
    expect(pv.containsKey('n'), isFalse);
    expect(pv.containsKey('pr'), isFalse);
    final ev = TacilyticsBeacon.build(domain: 'x.com', platform: 'ios', sessionId: 's' * 24, screen: '/cart', name: 'Purchase', properties: {'value': 12.5});
    expect(ev['n'], 'Purchase');
    expect(ev['pr'], {'value': '12.50'});
  });

  test('invalid region is not sent', () {
    final b = TacilyticsBeacon.build(domain: 'x.com', platform: 'ios', sessionId: 's' * 24, screen: '/', region: '419');
    expect(b.containsKey('cc'), isFalse);
  });

  test('client sends nothing until enabled', () async {
    final c = Tacilytics.init(endpoint: 'http://127.0.0.1:9', domain: 'x.com', platformOverride: 'android');
    expect(c.enabled, isFalse);
    await c.screen('/home'); // must return quietly, no network attempt
  });
}
