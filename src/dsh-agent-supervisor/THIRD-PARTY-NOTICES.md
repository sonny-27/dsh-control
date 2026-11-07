# Third-Party Notices

The MIT license in this package covers its original integration code only.

- DeepSeek Harness `0.2.0-rc.2` supplies the host lifecycle, Session APIs,
  authentication, frontend slots, icon components and native subagent chat.
  It is an external prerequisite, not bundled or relicensed by this package.
- `zod@4.6.5` is a declared dependency under its upstream MIT license. Preserve
  its copyright and license when distributing installed dependencies.
- React and the UI icon implementation are provided by the installed DSH
  client. Their original terms remain applicable.

Official runtime snapshots used for local compatibility tests remain outside
this package in the private work directory. No native DSH client bundle,
business conversation, user template, credential or attachment is included.
