// Deterministic counting gate — "how many r's in strawberry" style questions are
// 100% computable. Free models routinely hallucinate on these (pattern-completing
// the previous answer instead of counting), which is exactly the kind of "garbage
// output" the free-tier philosophy says to fix with more client-side processing,
// never a premium model. Counting is arithmetic, not generation — so skip the
// model for this narrow class of question and just compute the real answer.
//
// The "are/is in" template only fires without an explicit "the word/string/name"
// marker when the needle is unambiguously a single letter (e.g. "r's") — otherwise
// it would hijack ordinary quantity questions like "how many calories are in a
// banana" (needle "calories", haystack captured as the article "a"). With the
// marker present, the question can only be about text, so any needle is safe.
const LETTER_ARE_IN_RX =
  /how\s+many\s+(?:of\s+)?(?:the\s+letters?\s+)?["']?([a-zA-Z](?:'s)?)["']?\s+(?:are|is)\s+in\s+(?:the\s+word\s+|the\s+string\s+|the\s+name\s+)?["']?([a-z][a-z0-9\-']*)["']?/i

const WORD_ARE_IN_RX =
  /how\s+many\s+(?:of\s+)?["']?([a-z][a-z\-]*(?:'s)?)["']?\s+(?:are|is)\s+in\s+(?:the\s+word\s+|the\s+string\s+|the\s+name\s+)["']?([a-z][a-z0-9\-']*)["']?/i

const HOW_MANY_TIMES_RX =
  /how\s+many\s+times\s+(?:does|do)\s+(?:the\s+letters?\s+)?["']?([a-z][a-z\-]*(?:'s)?)["']?\s+(?:appear|occur)s?\s+in\s+(?:the\s+word\s+|the\s+string\s+|the\s+name\s+)?["']?([a-z][a-z0-9\-']*)["']?/i

const COUNT_OF_IN_RX =
  /count\s+(?:the\s+(?:number|amount)\s+of\s+)?(?:the\s+letters?\s+)?["']?([a-z][a-z\-]*(?:'s)?)["']?\s+in\s+(?:the\s+word\s+|the\s+string\s+|the\s+name\s+)?["']?([a-z][a-z0-9\-']*)["']?/i

export interface CountingAnswer {
  text: string
  needle: string
  haystack: string
  count: number
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])
const stripQuotes = (s: string) => s.replace(/^["']+|["']+$/g, '').trim()

function countSubstring(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while (true) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) break
    count++
    idx = found + needle.length
  }
  return count
}

export function answerCountingQuery(message: string): CountingAnswer | null {
  const trimmed = (message ?? '').trim()
  if (!trimmed) return null

  const m =
    trimmed.match(LETTER_ARE_IN_RX) ??
    trimmed.match(WORD_ARE_IN_RX) ??
    trimmed.match(HOW_MANY_TIMES_RX) ??
    trimmed.match(COUNT_OF_IN_RX)
  if (!m) return null

  const needleRaw = stripQuotes(m[1])
  const haystackRaw = stripQuotes(m[2])
  // Sanity bounds: haystack must be a single word-like token, not a run-on phrase
  // the regex over-captured — bail rather than guess if it looks off.
  if (!needleRaw || !haystackRaw || /\s/.test(haystackRaw) || haystackRaw.length > 40) return null

  const letterMatch = needleRaw.match(/^([a-zA-Z])'?s?$/)
  const needleLower = needleRaw.toLowerCase()
  const haystackLower = haystackRaw.toLowerCase()

  let count: number
  let displayNeedle: string
  let noun = 'occurrence'

  if (letterMatch) {
    const letter = letterMatch[1].toLowerCase()
    displayNeedle = letter
    count = [...haystackLower].filter(ch => ch === letter).length
    return {
      text: `There ${count === 1 ? 'is' : 'are'} **${count}** "${letter}"${count === 1 ? '' : "'s"} in "${haystackRaw}".`,
      needle: letter,
      haystack: haystackRaw,
      count,
    }
  }

  if (/^letters?$/.test(needleLower)) {
    count = haystackLower.length
    displayNeedle = 'letter'
    noun = 'letter'
  } else if (/^vowels?$/.test(needleLower)) {
    count = [...haystackLower].filter(ch => VOWELS.has(ch)).length
    displayNeedle = 'vowel'
    noun = 'vowel'
  } else if (/^consonants?$/.test(needleLower)) {
    count = [...haystackLower].filter(ch => /[a-z]/.test(ch) && !VOWELS.has(ch)).length
    displayNeedle = 'consonant'
    noun = 'consonant'
  } else {
    displayNeedle = needleRaw
    count = countSubstring(haystackLower, needleLower)
    return {
      text: `"${haystackRaw}" contains "${displayNeedle}" **${count}** time${count === 1 ? '' : 's'}.`,
      needle: displayNeedle,
      haystack: haystackRaw,
      count,
    }
  }

  return {
    text: `"${haystackRaw}" has **${count}** ${noun}${count === 1 ? '' : 's'}.`,
    needle: displayNeedle,
    haystack: haystackRaw,
    count,
  }
}
