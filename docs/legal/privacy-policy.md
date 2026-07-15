<!--
DRAFT — not legal advice. Reflects Octave's actual data practices as of the
effective date. Before publishing: (1) reconcile with a reputable generator
(Termly / iubenda) or a lawyer, especially for GDPR/CCPA wording; (2) keep it
accurate — if a practice changes (analytics, new sub-processor, new Google
scope), update this and re-notify users. Publish at https://octave.run/privacy
and list that URL in the Google OAuth consent screen.
-->

# Privacy Policy

**Effective date:** July 10, 2026

Octave ("Octave", "we", "us") is a local-first writing app operated by **Minkyo
Jung** (an individual). This policy explains what personal data we collect, why,
who we share it with, and the choices you have.

Questions or requests: **william@octave.run**.

## The short version

- Your **notes stay on your own device** as plain Markdown files. We do not
  collect, store, or have access to your note content on our servers.
- We collect the minimum needed to run an account and send you service emails:
  your Google profile basics and your email address.
- When you ask the AI for help, the relevant text is sent to **Anthropic
  (Claude)** to generate a response — this is how the AI works, and it is
  governed by your own Claude/Anthropic terms.
- We do **not** sell your personal information.

## 1. Information we collect

**Account information (via Google Sign-In).** When you sign in with Google, we
receive your **name, email address, profile picture, and your Google account ID
(`sub`)** through the `openid`, `email`, and `profile` scopes. We use this to
identify your account and personalize the app.

**Email address (for service emails).** Your email is added to our email
provider (Loops) so we can send you account/service ("transactional") emails,
such as the welcome email.

**Email engagement.** Our email provider (Loops) may record standard delivery
and engagement data (whether an email was delivered, opened, or a link clicked)
to operate email sending.

**Limited technical data.** When your app talks to our sign-up relay (a
Cloudflare Worker), standard request metadata (such as IP address) may be
processed transiently to route the request and prevent abuse. We do not use this
to build advertising profiles.

**What we do NOT collect.** We do **not** collect or store your notes, documents,
or their contents on our servers — they live locally on your device. We do not
use third-party advertising or cross-site tracking.

## 2. Your notes and the AI

Your notes are stored **locally on your device** as Markdown files. Octave never
uploads them to our servers.

When you explicitly ask the AI to do something (e.g., suggest an edit), the
relevant text needed for that request is sent to **Anthropic (Claude)** so it can
generate a response. This processing is governed by Anthropic's terms and your
own Claude subscription. We do not store that content on our servers.

## 3. How we use your data and legal bases (GDPR)

| Purpose | Data | Legal basis (GDPR) |
|---|---|---|
| Create and identify your account | Google profile basics | Performance of a contract |
| Send account/service ("transactional") emails | Email, name | Legitimate interest / performance of a contract |
| Prevent abuse of our sign-up relay | Limited technical data | Legitimate interest |
| Marketing emails (only if we add them later) | Email | Consent (separate opt-in) |

We currently send only transactional email. We will not send marketing email
without a separate, explicit opt-in.

## 4. Who we share it with (sub-processors)

We share personal data only with service providers that help us run Octave:

- **Google** — sign-in / authentication.
- **Loops** — email delivery and contact management.
- **Amazon Web Services (SES)** — email sending infrastructure used by Loops.
- **Cloudflare** — the sign-up relay (Worker) that connects the app to Loops.
- **Anthropic (Claude)** — AI processing of content you send when you use AI
  features (under your own Claude subscription).
- **Vercel** — hosting for the octave.run website (not your app data).

We do not sell or rent your personal information.

## 5. Storage and security

Authentication tokens are stored **encrypted on your own device** (AES-256-GCM
with a device-derived key). Data held by our sub-processors is protected by their
own security measures. No method of storage or transmission is 100% secure, but
we minimize what we collect and hold.

## 6. Data retention

We keep your contact record (email and profile basics) for as long as you have an
account, and delete it on request or a reasonable period after you ask us to. You
can disconnect Google in the app at any time, which removes the stored tokens from
your device.

## 7. International transfers

Our sub-processors are based in the United States and other countries, so your
data may be processed outside your country of residence, including outside the
EEA. Where required, transfers rely on appropriate safeguards (such as the
processors' standard contractual clauses).

## 8. Your rights

Depending on where you live, you may have the right to **access, correct, delete,
export (port), or restrict** the personal data we hold, to **object** to certain
processing, and to **withdraw consent**. California residents may request to
**know** and **delete** their personal information and to opt out of any "sale" or
"sharing" (we do not sell or share). We will not discriminate against you for
exercising these rights.

To make a request, email **william@octave.run**. We may need to verify your
identity before acting.

## 9. Email communications

Service emails (like the welcome email) are transactional and necessary to use
the product. If we later introduce marketing emails, they will require your
explicit opt-in and every one will include an unsubscribe link.

## 10. Children

Octave is not directed to children under 16, and we do not knowingly collect
personal data from them. If you believe a child has provided us data, contact us
and we will delete it.

## 11. Google API Services — Limited Use

Octave's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## 12. Changes to this policy

We may update this policy. Material changes will be posted here with a new
effective date, and — where the change affects how we use Google user data — we
will notify you and ask for renewed consent before the new use takes effect.

## 13. Contact

**Minkyo Jung** — **william@octave.run**

*Governing law for the related Terms of Service: Republic of Korea. Applicable
data-protection laws (e.g., GDPR, CCPA) apply based on where you are located.*
