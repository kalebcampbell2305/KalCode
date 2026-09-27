// The installed handler must preserve both the executable and the opaque URL as single arguments.
export function windowsProtocolProblems(registration, executable) {
  const problems = [];
  if (registration?.exists !== true) problems.push("kalcode protocol key missing");
  if (registration?.urlProtocol !== true) problems.push("URL Protocol marker missing");
  if (registration?.command !== `"${executable}" "%1"`)
    problems.push("protocol command does not match installed executable and quoted URL argument");
  return problems;
}
