#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Applies the KalCode Remote App Store listing (en-US) through the App Store Connect API.
# Idempotent: safe to re-run after editing the copy below.
#
#   ruby asc_metadata.rb [version=1.0]

require_relative 'asc'

VERSION = ARGV[0] || '1.0'

NAME = 'KalCode Remote'
SUBTITLE = 'Mission control for AI agents'
PROMO = 'Approve, steer and ship from your iPhone or iPad. Every agent on your KalCode workstation, ' \
        'in your pocket — end-to-end encrypted, no cloud account.'
KEYWORDS = 'ai,agents,coding,developer,approvals,diff,code review,remote,fleet,voice,git,devtools,workstation'
SUPPORT_URL = 'https://kalcoded.com/docs'
MARKETING_URL = 'https://kalcoded.com'
PRIVACY_URL = 'https://kalcoded.com/privacy'
COPYRIGHT = '2026 Kaleb Campbell'

DESCRIPTION = <<~TEXT.strip
  KalCode Remote is the companion app for KalCode, the desktop workspace for running AI coding agents. Pair your iPhone or iPad with KalCode on your Windows PC or Mac and keep your whole agent fleet within reach — from the couch, the kitchen, or anywhere your network or Tailscale reaches.

  REQUIRES KALCODE ON A WORKSTATION
  KalCode Remote doesn't run agents itself. It connects to KalCode on your own Windows PC or Mac, which does the work. Want a look first? Tap "Explore a demo workstation" on the welcome screen.

  MISSION CONTROL
  • Every agent at a glance — working, testing, waiting, failed or done — with its model, branch and latest activity.
  • Filter the fleet and jump straight to what changed.

  NEEDS YOU
  • Approve or deny commands the moment an agent asks.
  • Answer questions so a waiting agent can keep going.
  • Optional notifications, only for decisions and outcomes.

  AGENTS AND DIFFS
  • Read the conversation, follow tool calls and the full log.
  • Review a clear, line-by-line diff of every file an agent changed.
  • Send a follow-up, stop, retry, or launch a new agent in any workspace.

  RUNS
  • Track tests, builds, releases and deployments, with logs and test results.
  • Check services and environments at a glance.

  KALVOICE
  • Speak or type a request — ask what needs you, or tell an agent what to do next — and KalVoice acts on your workstation.

  PRIVATE BY DESIGN
  • Pair with a one-time QR code. Your workstation is the only server.
  • End-to-end encrypted (Noise protocol) over your local network or Tailscale.
  • No cloud account, no sign-up, no tracking. KalCode Remote collects no data.

  Get KalCode for your workstation at kalcoded.com.
TEXT

REVIEW_NOTES = <<~TEXT.strip
  KalCode Remote is a companion app. It pairs with the KalCode desktop app (Windows or macOS) over the local network or a private VPN such as Tailscale, using a one-time QR code shown on the workstation. There is no account and no server: the workstation is the only endpoint, and traffic is end-to-end encrypted.

  Because a review device can't reach a KalCode workstation, the app includes a complete in-app demo. On the welcome screen, tap "Explore a demo workstation". It runs the real interface against a simulated workstation entirely on the device (no network). Everything can be exercised there: Mission Control (agent fleet), Needs You (approve or deny; approving removes the request), agent detail with conversation, follow-up prompts, stop and retry, diffs, Runs (tests, services, environments), launching an agent, and KalVoice (type or speak a request). A "Demo" badge stays visible throughout; Settings → Exit demo returns to the welcome screen.

  Permissions: camera (scan the pairing QR code), microphone and speech recognition (KalVoice, optional), notifications (optional). The app collects no data.
TEXT

abort "Subtitle too long (#{SUBTITLE.size})" if SUBTITLE.size > 30
abort "Promotional text too long (#{PROMO.size})" if PROMO.size > 170
abort "Keywords too long (#{KEYWORDS.size})" if KEYWORDS.size > 100
abort "Description too long (#{DESCRIPTION.size})" if DESCRIPTION.size > 4000

app_id = ASC::APP_ID
step = ->(label) { puts "✓ #{label}" }

# App: content rights.
ASC.patch("/v1/apps/#{app_id}", data: { type: 'apps', id: app_id,
                                        attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' } })
step.call('content rights: no third-party content')

# App info: categories, name/subtitle/privacy URL, age rating.
info = ASC.all("/v1/apps/#{app_id}/appInfos").find { |i| i.dig('attributes', 'state') != 'READY_FOR_DISTRIBUTION' }
ASC.patch("/v1/appInfos/#{info['id']}", data: { type: 'appInfos', id: info['id'], relationships: {
  primaryCategory: ASC.rel('appCategories', 'DEVELOPER_TOOLS'),
  secondaryCategory: ASC.rel('appCategories', 'PRODUCTIVITY'),
} })
step.call('categories: Developer Tools / Productivity')

info_loc = ASC.all("/v1/appInfos/#{info['id']}/appInfoLocalizations").find { |l| l.dig('attributes', 'locale') == 'en-US' }
ASC.patch("/v1/appInfoLocalizations/#{info_loc['id']}", data: { type: 'appInfoLocalizations', id: info_loc['id'],
                                                                attributes: { name: NAME, subtitle: SUBTITLE, privacyPolicyUrl: PRIVACY_URL } })
step.call("name, subtitle (#{SUBTITLE.size}/30), privacy policy URL")

age = ASC.get("/v1/appInfos/#{info['id']}/ageRatingDeclaration")['data']
frequencies = %w[alcoholTobaccoOrDrugUseOrReferences contests gamblingSimulated gunsOrOtherWeapons horrorOrFearThemes
                 matureOrSuggestiveThemes medicalOrTreatmentInformation profanityOrCrudeHumor sexualContentGraphicAndNudity
                 sexualContentOrNudity violenceCartoonOrFantasy violenceRealistic violenceRealisticProlongedGraphicOrSadistic]
flags = %w[advertising ageAssurance gambling healthOrWellnessTopics lootBox messagingAndChat parentalControls
           socialMedia unrestrictedWebAccess userGeneratedContent]
attrs = frequencies.map { |k| [k, 'NONE'] }.to_h.merge(flags.map { |k| [k, false] }.to_h)
attrs.select! { |k, _| age['attributes'].key?(k) }
ASC.patch("/v1/ageRatingDeclarations/#{age['id']}", data: { type: 'ageRatingDeclarations', id: age['id'], attributes: attrs })
step.call("age rating: #{attrs.size} answers, all None/No")

# Version: copyright, release type, localization.
ver = ASC.version(VERSION)
ASC.patch("/v1/appStoreVersions/#{ver['id']}", data: { type: 'appStoreVersions', id: ver['id'],
                                                       attributes: { copyright: COPYRIGHT, releaseType: 'AFTER_APPROVAL' } })
step.call('copyright, release automatically after approval')

ver_loc = ASC.all("/v1/appStoreVersions/#{ver['id']}/appStoreVersionLocalizations").find { |l| l.dig('attributes', 'locale') == 'en-US' }
ASC.patch("/v1/appStoreVersionLocalizations/#{ver_loc['id']}", data: { type: 'appStoreVersionLocalizations', id: ver_loc['id'], attributes: {
  description: DESCRIPTION, keywords: KEYWORDS, promotionalText: PROMO, supportUrl: SUPPORT_URL, marketingUrl: MARKETING_URL,
} })
step.call("description (#{DESCRIPTION.size}), keywords (#{KEYWORDS.size}/100), promo (#{PROMO.size}/170), support + marketing URLs")
puts "  version localization id: #{ver_loc['id']}"

# App Review information. Apple requires a contact phone to create it; pass it as
# ASC_REVIEW_PHONE="+1 555 123 4567" (it is not stored in the repo).
review = {
  contactFirstName: 'Kaleb', contactLastName: 'Campbell', contactEmail: 'kalebcampbell2323@gmail.com',
  demoAccountRequired: false, notes: REVIEW_NOTES,
}
review[:contactPhone] = ENV['ASC_REVIEW_PHONE'] if ENV['ASC_REVIEW_PHONE'].to_s.strip != ''
existing = ASC.get("/v1/appStoreVersions/#{ver['id']}/appStoreReviewDetail")['data']
if existing
  ASC.patch("/v1/appStoreReviewDetails/#{existing['id']}", data: { type: 'appStoreReviewDetails', id: existing['id'], attributes: review })
  step.call("App Review contact, notes, no demo account needed#{review[:contactPhone] ? ', phone' : ''}")
elsif review[:contactPhone]
  ASC.post('/v1/appStoreReviewDetails', data: { type: 'appStoreReviewDetails', attributes: review,
                                                relationships: { appStoreVersion: ASC.rel('appStoreVersions', ver['id']) } })
  step.call('App Review contact, phone, notes, no demo account needed')
else
  puts '! App Review information skipped: Apple requires a contact phone. Re-run with ASC_REVIEW_PHONE="+1 ..."'
end

# Price: free, base territory USA.
free = ASC.all("/v1/apps/#{app_id}/appPricePoints?filter[territory]=USA&limit=200")
          .find { |p| p.dig('attributes', 'customerPrice').to_f.zero? }
abort 'No free price point for USA' unless free
ASC.post('/v1/appPriceSchedules', {
  data: { type: 'appPriceSchedules', relationships: {
    app: ASC.rel('apps', app_id), baseTerritory: ASC.rel('territories', 'USA'),
    manualPrices: { data: [{ type: 'appPrices', id: '${free}' }] },
  } },
  included: [{ type: 'appPrices', id: '${free}', attributes: { startDate: nil },
               relationships: { appPricePoint: ASC.rel('appPricePoints', free['id']) } }],
})
step.call('price: Free (base territory USA)')

# Availability: every territory, and new ones automatically.
begin
  ASC.get("/v1/apps/#{app_id}/appAvailabilityV2")
  step.call('availability already set')
rescue ASC::Error => e
  raise unless e.status == 404
  territories = ASC.all('/v1/territories?limit=200').map { |t| t['id'] }
  ASC.post('/v2/appAvailabilities', {
    data: { type: 'appAvailabilities', attributes: { availableInNewTerritories: true }, relationships: {
      app: ASC.rel('apps', app_id),
      territoryAvailabilities: { data: territories.map { |t| { type: 'territoryAvailabilities', id: "${#{t}}" } } },
    } },
    included: territories.map do |t|
      { type: 'territoryAvailabilities', id: "${#{t}}", attributes: { available: true },
        relationships: { territory: ASC.rel('territories', t) } }
    end,
  })
  step.call("availability: all #{territories.size} territories")
end
