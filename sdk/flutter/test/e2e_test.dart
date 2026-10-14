@Tags(['e2e'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tacilytics/tacilytics.dart';

// Runs against a live server: TACILYTICS_E2E=http://127.0.0.1:3999 flutter test --tags e2e
void main() {
  final url = Platform.environment['TACILYTICS_E2E'];
  test('beacons reach a running server', () async {
    final c = Tacilytics.init(endpoint: url!, domain: 'pastaclean.tv', appVersion: '9.9.9-e2e', platformOverride: 'android', enabled: true);
    await c.screen('/e2e/home');
    await c.search('essig', 6);
    await c.purchase(value: 12.5, items: 1);
  }, skip: url == null ? 'set TACILYTICS_E2E' : false);
}
