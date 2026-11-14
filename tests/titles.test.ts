import { describe, expect, it } from 'vitest';
import { bestMatch, plausibleChapters, saysNovel, similarity, slugTitle, titleVariants, type Candidate } from '../src/main/titles';

const cand = (names: string[], extra: Partial<Candidate> = {}): Candidate => ({ names, primary: 1, ...extra });

describe('titleVariants', () => {
  it('completes a page title the site cut off', () => {
    expect(titleVariants('Martial God Regressed To Level', 'martial-god-regressed-to-level-2')[0]).toBe('Martial God Regressed To Level 2');
    expect(titleVariants('The Greatest Estate Develo', 'the-greatest-estate-developer')[0]).toBe('The Greatest Estate Developer');
    expect(titleVariants('Versatile Mage', 'versatile-mage01')[0]).toBe('Versatile Mage');
    expect(titleVariants('Doomsday for All: Me, Virus Monar', 'doomsday-for-all-me-virus-monarch')[0]).toBe('Doomsday For All Me Virus Monarch');
  });
  it('straightens curly apostrophes', () => {
    expect(titleVariants('Swordmaster’s Youngest Son', 'swordmaster-s-youngest-son')[0]).toBe("Swordmaster's Youngest Son");
  });
  it('restores apostrophes lost in a slug-derived name', () => {
    expect(titleVariants('I M Really Not The Demon God S Lackey', 'i-m-really-not-the-demon-god-s-lackey')[0]).toBe("I'm Really Not The Demon God's Lackey");
    expect(slugTitle('the-novel-s-extra-remake')).toBe("The Novel's Extra Remake");
  });
  it('keeps punctuation when the slug adds nothing', () => {
    expect(titleVariants('High Martiality: With One Hand!', 'high-martiality-with-one-hand')[0]).toBe('High Martiality: With One Hand!');
  });
  it('strips site decorations', () => {
    expect(titleVariants('Reincarnator (Manhwa)', 'reincarnator-manhwa')[0]).toBe('Reincarnator');
    expect(titleVariants('Max Talent Player', 'max-talent-player-2024')).toContain('Max Talent Player');
    expect(titleVariants('Overgeared Team Argo', 'overgeared-team-argo')[0]).toBe('Overgeared');
    expect(titleVariants('unOrdinary', 'unordinary-101')).toContain('Unordinary');
  });
  it('splits a second name in brackets', () => {
    const v = titleVariants('Heavenly Inquisition Sword (Nine Heavens Swordmaster)', 'heavenly-inquisition-sword-nine-heavens-swordmaster');
    expect(v).toContain('Heavenly Inquisition Sword');
    expect(v).toContain('Nine Heavens Swordmaster');
  });
  it('tries the slug name when it differs from the page title', () => {
    expect(titleVariants('Dark Lady', 'mookhyang-dark-lady')).toEqual(expect.arrayContaining(['Dark Lady', 'Mookhyang Dark Lady']));
    expect(titleVariants('Gatekeeper Of The Boundless World', '2vvd-gatekeeper-of-the-boundless-world')[0]).toBe('Gatekeeper Of The Boundless World');
  });
  it('knows when the site means the novel', () => {
    expect(saysNovel('Solo Leveling Novel', 'solo-leveling-novel')).toBe(true);
    expect(saysNovel("The Novel's Extra", 'the-novel-s-extra-remake')).toBe(false);
  });
});

describe('similarity', () => {
  it('is 1 only for identical names', () => {
    expect(similarity("World's Strongest Troll", 'World’s Strongest Troll')).toBe(1);
    expect(similarity('The Return of the Disaster-Class Hero', 'Return of the Disaster-Class Hero')).toBeGreaterThanOrEqual(0.98);
  });
  it('accepts small spelling differences', () => {
    expect(similarity('Levelling Up, By Only Eating!', 'Leveling Up, by Only Eating!')).toBeGreaterThanOrEqual(0.9);
    expect(similarity('Isekai Maou to Shoukan Shoujo Dorei Majutsu', 'Isekai Maou to Shoukan Shoujo no Dorei Majutsu')).toBeGreaterThanOrEqual(0.9);
  });
  it('rejects different series and sequels', () => {
    expect(similarity('Max Talent Player', 'The Maxed-Out Player')).toBeLessThan(0.9);
    expect(similarity('Dungeon Reset', 'Dungeon Reset 2')).toBeLessThan(0.9);
    expect(similarity('Doupo Cangqiong', 'Dou Po Cangqiong: Yao Lao Chuanqi')).toBeLessThan(0.9);
  });
});

describe('bestMatch', () => {
  it('prefers a main title over a synonym', () => {
    const hits = [cand(['Jeonsaengja', 'Reincarnator']), cand(['Reincarnator']), cand(['Past Life Returner'])];
    expect(bestMatch(['Reincarnator'], hits)?.index).toBe(1);
  });
  it('rejects a spin-off with far fewer chapters than were read', () => {
    const spinOff = cand(['Doupo Cangqiong'], { totalChapters: 175 });
    expect(bestMatch(['Doupo Cangqiong'], [spinOff], 434)).toBeUndefined();
    expect(plausibleChapters(268, 269)).toBe(true);
    expect(plausibleChapters(175, 434)).toBe(false);
  });
  it('takes novels only when the site said novel', () => {
    const hits = [cand(['Solo Leveling'], { format: 'NOVEL' }), cand(['Solo Leveling'], { format: 'MANGA' })];
    expect(bestMatch(['Solo Leveling'], hits)?.index).toBe(1);
    expect(bestMatch(['Solo Leveling'], hits, 0, true)?.index).toBe(0);
  });
  it('leaves an unclear fuzzy match for manual review', () => {
    const hits = [cand(['Return of the Blossoming Blade']), cand(['Return of the Blossoming Blades'])];
    expect(bestMatch(['Return of the Blossoming Blad'], hits)).toBeUndefined();
    expect(bestMatch(['Something Else Entirely'], hits)).toBeUndefined();
  });
});
