// Koppling till databasen.
// Tomma värden = demoläge: allt sparas i den här webbläsaren och syns i
// andra flikar på samma dator, men inte på andra enheter. Bra för att
// prova systemet. Inför turneringen: skapa ett Supabase-projekt, kör
// supabase/schema.sql och klistra in projektets URL och anon-nyckel här.
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

// Evenemanget som startsidan (Tabell- och Resultat-korten) och /live
// visar när ingen ?e= anges.
export const SITE_EVENT = 'boulekampen-2026';
