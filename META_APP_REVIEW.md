# Meta App Review notes

The full review prep now lives in [docs/review/meta.md](docs/review/meta.md):

- every Instagram and Facebook Page permission, the feature it powers and why it is needed
- the URLs Meta asks for, including the deauthorize and data deletion callbacks
- the rules the engine enforces (one private reply per comment within 7 days, the 24 hour window, Human Agent)
- how a reviewer signs in and tests
- the screencast scripts
- the owner checklist

Each later platform gets its own file in `docs/review/`.

You need App Review only if accounts that have no role on your Meta app will connect. If you run MyReply for your own accounts, added as testers, skip it. See "Letting other people use your instance" in [docs/setup.md](docs/setup.md).

## Business verification

Meta usually requires business verification before granting Advanced Access. It asks for a document proving a legal entity: a business registration or license, articles of incorporation, a business tax document, or a business bank statement. Without a registered business you cannot complete this step, and the practical path is to run MyReply for your own accounts, which never needs review.
