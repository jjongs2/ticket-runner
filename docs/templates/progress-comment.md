<!-- agent-pipeline:progress -->
**agent-pipeline** · run `<runId>` · `<branch>`

| Stage | Outcome | Turns | Duration |
|---|---|---|---|
| implement | ✅ committed | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| verify | ❌ <k> unmet | <n> | <m>m |
| fix | ✅ committed | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| verify | ✅ <k> met · <u> unverifiable | <n> | <m>m |
| conflict | ✅ rebased | <n> | <m>m |
| checks | ✅ passed | – | <m>m |
| ci | ✅ passed | – | <m>m |
| merge | ✅ #<pr> | – | – |
