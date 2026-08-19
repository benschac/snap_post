Pod::Spec.new do |s|
  s.name           = 'SnapNative'
  s.version        = '1.0.0'
  s.summary        = 'Native audio capture and performance telemetry for Snap to Post'
  s.description    = 'A local Expo module for 16 kHz PCM capture, thermal telemetry, and signposts.'
  s.author         = 'Snap to Post'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '17.0'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
