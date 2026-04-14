{ ... }:
{
  system.defaults = {
    NSGlobalDomain = {
      "com.apple.swipescrolldirection" = false;
      AppleInterfaceStyleSwitchesAutomatically = true;

      LaunchServices.LSHandlers = [
        { LSHandlerContentType = "public.lzip-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lz4-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lz4-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.zip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.zip-archive.first-part"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.pkware.zip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.winzip.zipx-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.xz-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.tukaani.xz-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.tar-xz-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.tukaani.tar-xz-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.tukaani.xz-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.google.brotli-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.brotli-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.google.brotli-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.brotli-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.zstandard-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.facebook.zstandard-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.facebook.zstandard-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.zstandard-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.rarlab.rar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.bzip2-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.bzip.bzip2-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "bzip2"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.redhat.bzip2-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "tbzip2"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.tar-bzip2-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "tb2"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.bzip.bzip2-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.bzip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "bzip"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "tbzip"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.gnu.gnu-zip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.gnu.gnu-zip-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "tgzip"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "tar-gz"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.gnu.gnu-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lrzip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.kolivas.lrzip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.kolivas.lrzip-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lrzip-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.cpio-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.apple.bom-compressed-cpio"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "cx.c3.pax-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.pax-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.archive.lha"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.microsoft.windows-executable"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.microsoft.cab-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.microsoft.cab"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.microsoft.msi-installer"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "msi"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.microsoft.wim-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "cbr"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "cbz"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "cpt"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.cyclos.cpt-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "cx.c3.arc-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "spk"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.synology.spk-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "xpi"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.microsoft.appx-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.winace.ace-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.apple.archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.apple.encrypted-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.plougher.squashfs-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.servmask.wpress-backup"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.z-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.google.snappy-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "com.google.snappy-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.7-zip.7-zip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "org.tukaani.lzma-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lzma-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentTag = "lzo"; LSHandlerContentTagClass = "public.filename-extension"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lzop-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lzop-tar-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
        { LSHandlerContentType = "public.lzip-archive"; LSHandlerRoleViewer = "com.aone.keka"; }
      ];
    };

    CustomUserPreferences = {
      NSGlobalDomain = {
        NSPreferredExternalTerminalApp = "com.mitchellh.ghostty";
      };

      "com.apple.HIToolbox" = {
        AppleCurrentKeyboardLayoutInputSourceID = "com.apple.keylayout.USInternational-PC";
        AppleEnabledInputSources = [
          {
            "Bundle ID" = "com.apple.CharacterPaletteIM";
            InputSourceKind = "Non Keyboard Input Method";
          }
          {
            InputSourceKind = "Keyboard Layout";
            "KeyboardLayout ID" = 15000;
            "KeyboardLayout Name" = "USInternational-PC";
          }
          {
            "Bundle ID" = "com.apple.PressAndHold";
            InputSourceKind = "Non Keyboard Input Method";
          }
        ];
        AppleSelectedInputSources = [
          {
            InputSourceKind = "Keyboard Layout";
            "KeyboardLayout ID" = 15000;
            "KeyboardLayout Name" = "USInternational-PC";
          }
          {
            "Bundle ID" = "com.apple.PressAndHold";
            InputSourceKind = "Non Keyboard Input Method";
          }
        ];
      };
    };
  };
}
