#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Minimal App Store Connect API client for KalCode Remote releases (no gems; Ruby 2.6+).
#
# Credentials come from ~/.appstoreconnect/kalcode-release.env (KEY_ID, ISSUER_ID, TEAM_ID) and
# ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8. Nothing secret lives in this file, and the
# key is never printed. Override the env file with ASC_ENV and the app with ASC_APP_ID.
#
#   ruby asc.rb get    /v1/apps/<id>/builds?limit=5
#   ruby asc.rb post   /v1/betaGroups '{"data":{...}}'      (JSON argument or @file.json)
#   ruby asc.rb patch  /v1/appInfos/<id> '{"data":{...}}'
#   ruby asc.rb delete /v1/appScreenshots/<id>
#   ruby asc.rb screenshots <appStoreVersionLocalizationId> <DISPLAY_TYPE> a.png b.png ...
#                                                         (replaces that set, keeps file order)
#   ruby asc.rb status                                    (version, builds, review readiness)
#   ruby asc.rb submit [version=1.0]                      (reviewSubmissions: create → item → submit)

require 'json'
require 'net/http'
require 'openssl'
require 'base64'
require 'digest'
require 'uri'

module ASC
  HOST = 'https://api.appstoreconnect.apple.com'
  APP_ID = ENV['ASC_APP_ID'] || '6819834499'

  class Error < StandardError
    attr_reader :status, :body
    def initialize(status, body)
      @status = status
      @body = body
      super("HTTP #{status}: #{body}")
    end
  end

  module_function

  def env
    @env ||= begin
      path = File.expand_path(ENV['ASC_ENV'] || '~/.appstoreconnect/kalcode-release.env')
      File.readlines(path).each_with_object({}) do |line, out|
        line = line.strip.sub(/\Aexport\s+/, '')
        next if line.empty? || line.start_with?('#') || !line.include?('=')
        k, v = line.split('=', 2)
        out[k.strip] = v.strip.gsub(/\A["']|["']\z/, '')
      end
    end
  end

  def b64url(data)
    Base64.urlsafe_encode64(data).delete('=')
  end

  # ES256 JWT, 15 minute lifetime (Apple's maximum is 20).
  def token
    return @token if @token && Time.now.to_i < @token_exp - 60
    key_id = env.fetch('KEY_ID')
    key = OpenSSL::PKey::EC.new(File.read(File.expand_path("~/.appstoreconnect/private_keys/AuthKey_#{key_id}.p8")))
    now = Time.now.to_i
    @token_exp = now + 15 * 60
    header = b64url(JSON.generate(alg: 'ES256', kid: key_id, typ: 'JWT'))
    claims = b64url(JSON.generate(iss: env.fetch('ISSUER_ID'), iat: now, exp: @token_exp, aud: 'appstoreconnect-v1'))
    input = "#{header}.#{claims}"
    der = key.sign(OpenSSL::Digest::SHA256.new, input)
    # JWS wants raw r||s (32 bytes each), not the DER SEQUENCE OpenSSL returns.
    r, s = OpenSSL::ASN1.decode(der).value.map { |i| i.value.to_s(2).rjust(32, "\0")[-32, 32] }
    @token = "#{input}.#{b64url(r + s)}"
  end

  def request(method, path, body = nil)
    uri = URI(path.start_with?('http') ? path : HOST + path)
    attempts = 0
    begin
      attempts += 1
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = true
      http.read_timeout = 120
      klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, patch: Net::HTTP::Patch, delete: Net::HTTP::Delete }.fetch(method)
      req = klass.new(uri)
      req['Authorization'] = "Bearer #{token}"
      if body
        req['Content-Type'] = 'application/json'
        req.body = body.is_a?(String) ? body : JSON.generate(body)
      end
      res = http.request(req)
      code = res.code.to_i
      if (code == 429 || code >= 500) && attempts < 5
        sleep(2**attempts)
        raise Net::ReadTimeout
      end
      raise Error.new(code, res.body) unless code.between?(200, 299)
      res.body.nil? || res.body.empty? ? {} : JSON.parse(res.body)
    rescue Net::ReadTimeout, Net::OpenTimeout, Errno::ECONNRESET, OpenSSL::SSL::SSLError
      retry if attempts < 5
      raise
    end
  end

  def get(path)
    request(:get, path)
  end
  def post(path, body)
    request(:post, path, body)
  end
  def patch(path, body)
    request(:patch, path, body)
  end
  def delete(path)
    request(:delete, path)
  end

  # Follows `links.next` and returns every `data` element.
  def all(path)
    out = []
    loop do
      page = get(path)
      out.concat(Array(page['data']))
      path = page.dig('links', 'next')
      break unless path
    end
    out
  end

  def rel(type, id)
    { data: { type: type, id: id } }
  end

  # MARK: Screenshots

  def screenshot_set(localization_id, display_type)
    sets = all("/v1/appStoreVersionLocalizations/#{localization_id}/appScreenshotSets")
    found = sets.find { |s| s.dig('attributes', 'screenshotDisplayType') == display_type }
    return found['id'] if found
    post('/v1/appScreenshotSets', data: {
      type: 'appScreenshotSets',
      attributes: { screenshotDisplayType: display_type },
      relationships: { appStoreVersionLocalization: rel('appStoreVersionLocalizations', localization_id) },
    })['data']['id']
  end

  def upload_screenshot(set_id, file)
    bytes = File.binread(file)
    shot = post('/v1/appScreenshots', data: {
      type: 'appScreenshots',
      attributes: { fileName: File.basename(file), fileSize: bytes.bytesize },
      relationships: { appScreenshotSet: rel('appScreenshotSets', set_id) },
    })['data']
    shot['attributes']['uploadOperations'].each do |op|
      uri = URI(op['url'])
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == 'https'
      req = Net::HTTPGenericRequest.new(op['method'], true, true, uri.request_uri)
      Array(op['requestHeaders']).each { |h| req[h['name']] = h['value'] }
      req.body = bytes.byteslice(op['offset'], op['length'])
      res = http.request(req)
      raise Error.new(res.code.to_i, res.body) unless res.code.to_i.between?(200, 299)
    end
    patch("/v1/appScreenshots/#{shot['id']}", data: {
      type: 'appScreenshots', id: shot['id'],
      attributes: { uploaded: true, sourceFileChecksum: Digest::MD5.hexdigest(bytes) },
    })
    shot['id']
  end

  def wait_for_screenshot(id)
    150.times do # Apple often takes a few minutes per image
      state = get("/v1/appScreenshots/#{id}")['data']['attributes']['assetDeliveryState']
      return state if %w[COMPLETE FAILED].include?(state['state'])
      sleep 2
    end
    { 'state' => 'TIMEOUT' }
  end

  def replace_screenshots(localization_id, display_type, files)
    set_id = screenshot_set(localization_id, display_type)
    all("/v1/appScreenshotSets/#{set_id}/appScreenshots").each { |s| delete("/v1/appScreenshots/#{s['id']}") }
    ids = files.map do |f|
      id = upload_screenshot(set_id, f)
      state = wait_for_screenshot(id)
      puts "#{display_type} #{File.basename(f)} → #{state['state']}#{state['errors'] ? " #{state['errors'].to_json}" : ''}"
      id
    end
    patch("/v1/appScreenshotSets/#{set_id}/relationships/appScreenshots", data: ids.map { |i| { type: 'appScreenshots', id: i } })
    set_id
  end

  # MARK: Review

  def version(version_string = '1.0')
    all("/v1/apps/#{APP_ID}/appStoreVersions?filter[platform]=IOS").find do |v|
      v.dig('attributes', 'versionString') == version_string
    end or abort("No App Store version #{version_string}")
  end

  def submit(version_string = '1.0')
    ver = version(version_string)
    open = all("/v1/reviewSubmissions?filter[app]=#{APP_ID}&filter[platform]=IOS")
           .find { |s| %w[READY_FOR_REVIEW].include?(s.dig('attributes', 'state')) }
    sub = open || post('/v1/reviewSubmissions', data: {
      type: 'reviewSubmissions', attributes: { platform: 'IOS' },
      relationships: { app: rel('apps', APP_ID) },
    })['data']
    items = all("/v1/reviewSubmissions/#{sub['id']}/items")
    if items.empty?
      post('/v1/reviewSubmissionItems', data: {
        type: 'reviewSubmissionItems',
        relationships: { reviewSubmission: rel('reviewSubmissions', sub['id']), appStoreVersion: rel('appStoreVersions', ver['id']) },
      })
    end
    done = patch("/v1/reviewSubmissions/#{sub['id']}", data: { type: 'reviewSubmissions', id: sub['id'], attributes: { submitted: true } })
    puts "Submitted #{version_string} for review: submission #{sub['id']} → #{done.dig('data', 'attributes', 'state')}"
  end

  def status
    ver = version
    a = ver['attributes']
    puts "Version #{a['versionString']}: #{a['appStoreState'] || a['appVersionState']} (release #{a['releaseType']})"
    build = get("/v1/appStoreVersions/#{ver['id']}/build")['data']
    puts "Attached build: #{build ? build.dig('attributes', 'version') : 'none'}"
    get("/v1/builds?filter[app]=#{APP_ID}&sort=-uploadedDate&limit=5")['data'].each do |b|
      ba = b['attributes']
      puts "Build #{ba['version']}: #{ba['processingState']} uploaded #{ba['uploadedDate']} encryption=#{ba['usesNonExemptEncryption'].inspect}"
    end
    all("/v1/reviewSubmissions?filter[app]=#{APP_ID}").each do |s|
      puts "Review submission #{s['id']}: #{s.dig('attributes', 'state')}"
    end
  end
end

if $PROGRAM_NAME == __FILE__
  cmd, *args = ARGV
  body = lambda do |arg|
    arg.to_s.start_with?('@') ? File.read(arg[1..]) : arg
  end
  begin
    case cmd
    when 'get' then puts JSON.pretty_generate(ASC.get(args[0]))
    when 'all' then puts JSON.pretty_generate(ASC.all(args[0]))
    when 'post' then puts JSON.pretty_generate(ASC.post(args[0], body.call(args[1])))
    when 'patch' then puts JSON.pretty_generate(ASC.patch(args[0], body.call(args[1])))
    when 'delete' then ASC.delete(args[0]) && puts('deleted')
    when 'screenshots' then ASC.replace_screenshots(args[0], args[1], args[2..])
    when 'status' then ASC.status
    when 'submit' then ASC.submit(args[0] || '1.0')
    else
      warn File.read(__FILE__).lines.drop(3).take_while { |l| l.start_with?('#') }.join
      exit 64
    end
  rescue ASC::Error => e
    warn "App Store Connect error #{e.status}"
    warn(begin
      JSON.pretty_generate(JSON.parse(e.body))
    rescue StandardError
      e.body
    end)
    exit 1
  end
end
