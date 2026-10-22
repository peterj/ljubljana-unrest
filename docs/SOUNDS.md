# Sounds

Clips in `public/sfx/` (mono MP3, trimmed and normalised with ffmpeg; voices re-checked with Whisper). All from
[Pixabay](https://pixabay.com/sound-effects/) under the Pixabay Content License (free for commercial use, no
attribution required). Source: `https://cdn.pixabay.com/audio/<date>/audio_<id>.mp3`.

BBC Sound Effects (sound-effects.bbcrewind.co.uk) has good matches too (Paris riots with shields and smoke grenades,
police operations room, London demonstrations), but its RemArc licence is personal / educational / research only, so
none are used. Atmosphere (city rumble, wind, tension drone, radio squelch, gas hiss, water spray, fire crackle, stone
impacts, accents, the embassy alarm klaxon) is synthesised at runtime with Tone.js (`src/audio/sound.ts`). The machine guns
in `massacre` reuse `shot_1–3`, pitched up and cut short.

| file | Pixabay title | source | segment (s) |
| --- | --- | --- | --- |
| radio_clear.mp3 | Military Radio Communication | `2024/07/08/0435defb3a` | 17.25–18.85 |
| radio_correct.mp3 | Thats correct | `2022/03/24/08b15ea692` | 0–1.3 |
| radio_onmyway.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 26.6–29.4 |
| radio_negative.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 128.8–131.3 |
| radio_maam.mp3 | Military Radio Communication | `2024/07/08/0435defb3a` | 27.8–29.45 |
| chat_1.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 36.2–40.3 |
| chat_2.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 42.8–45.2 |
| chat_3.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 91.6–99.4 |
| chat_4.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 130.8–138.4 |
| chat_5.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 144.6–150.4 |
| chat_6.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 189.6–197.4 |
| chat_7.mp3 | Military Radio Communication | `2024/07/08/0435defb3a` | 0.5–8.8 |
| chat_8.mp3 | Military Radio Communication | `2024/07/08/0435defb3a` | 9.6–16.25 |
| chat_9.mp3 | Los Angeles (South Bay) Police and Fire Scanner | `2022/01/18/37ef10109b` | 232.6–239.4 |
| chat_10.mp3 | Military Radio Communication | `2024/07/08/0435defb3a` | 21.9–24.8 |
| voice_arrest.mp3 | Police | `2022/03/15/94ad504ed5` | 4.1–6.9 |
| voice_silent.mp3 | Police | `2022/03/15/94ad504ed5` | 6.7–8.9 |
| voice_weapon.mp3 | Police | `2022/03/15/94ad504ed5` | 0–3.85 |
| voice_disperse.mp3 | Lawful Order | `2022/03/10/7e1089a8d9` | 0–10.3 |
| whistle_1.mp3 | Police Whistle FX 1 | `2026/07/13/5b64cc901d` | 0–0.9 |
| whistle_2.mp3 | Police Whistle FX 3 | `2026/07/13/3124e3b4a8` | 0–0.86 |
| whistle_3.mp3 | Police Whistle FX 5 | `2026/07/13/8071ba0f5f` | 0–1.22 |
| whistle_long.mp3 | Police Whistle FX 2 | `2026/07/13/eb5611d5b6` | 0–1.33 |
| siren_loop.mp3 | police | `2021/08/04/de8a3ad9c6` | 2–22 |
| siren_arrive.mp3 | Police Operation Siren | `2023/03/28/9723613051` | 0–8 |
| siren_far.mp3 | Police Sirens(far) | `2022/03/14/f03151c1d2` | 0–58 |
| car_pass.mp3 | Police car | `2025/02/07/1b27a31446` | 0–16.4 |
| shot_1.mp3 | Single Gunshot 5.4 | `2022/03/10/b4f6ca7d10` | 0–1.6 |
| shot_2.mp3 | Rifle Gunshot | `2022/03/24/1dcc7d1df8` | 0–1.85 |
| shot_3.mp3 | Single Pistol Gunshot 3.3 | `2022/03/10/dad91ab3de` | 0–1.6 |
| gas_launch.mp3 | Grenade Launcher | `2022/03/25/2302d93df4` | 0–0.47 |
| bang.mp3 | Police Siren, Water Cannon, Tear Gas, People Coughing and Protesters | `2022/03/09/2bff5a59d1` | 36.8–39.4 |
| handcuffs.mp3 | Handcuffs | `2022/03/17/db1a7c05aa` | 1.45–2.6 |
| smash.mp3 | Molotov Cocktail Impact Sound | `2024/01/09/680a256b53` | 0–1.85 |
| truck.mp3 | Armored Anti Riot Water Cannon Truck in action | `2022/02/07/7a27bc5ba1` | 2–48 |
| crowd_calm.mp3 | Crowd on Moscow anti-corruption protest | `2022/02/10/45eb4e0a82` | 0–110 |
| crowd_roar.mp3 | Crowd on Moscow anti-corruption protest | `2022/02/10/45eb4e0a82` | 188–208 |
| drums.mp3 | Protest 02 | `2022/03/13/86af8bdb95` | 0–118 |
| panic.mp3 | Crowd screaming | `2021/08/09/dabef2f7cc` | 6–26 |
| riot.mp3 | Police Siren, Water Cannon, Tear Gas, People Coughing and Protesters | `2022/03/09/2bff5a59d1` | 96–132 |
