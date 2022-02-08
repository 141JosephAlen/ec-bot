import { Message, Util, MessageAttachment } from 'discord.js';
import Database from 'better-sqlite3';
import * as https from 'https';
import * as diff from 'recursive-diff';
import * as he from 'he';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';

export abstract class Roadmap {
    public static readonly command = '!roadmap';
    public static readonly description = 'Keeps track of roadmap changes from week to week. Pull the latest version of the roadmap for today or to compare the latest pull to the previous.';
    public static readonly usage = 'Usage: `!roadmap [pull/compare]`';

    private static readonly deliverablesGraphql = fs.readFileSync(path.join(__dirname, '..', 'graphql', 'deliverables.graphql'), 'utf-8');
    private static readonly teamsGraphql = fs.readFileSync(path.join(__dirname, '..', 'graphql', 'teams.graphql'), 'utf-8');
    private static readonly SortByEnum = Object.freeze({
        ALPHABETICAL: "ALPHABETICAL",
        CHRONOLOGICAL: "CHRONOLOGICAL"
    });
    private static readonly CategoryEnum = Object.freeze({
        CoreTech: 1,
        Gameplay: 2,
        Characters: 3,
        Locations: 4,
        AI: 5,
        ShipsAndVehicles: 6,
        WeaponsAndItems: 7
    });
    private static readonly QueryTypeEnum = Object.freeze({
        Deliverables: 1,
        Teams: 2
    });
    private static readonly ProjectEnum = Object.freeze({
        SQ42: "el2codyca4mnx",
        SC: "ekm24a6ywr3o3"
    });
    private static readonly options = {
        hostname: 'robertsspaceindustries.com',
        path: '/graphql',
        method: 'POST',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
    };

    /**
     * 
     * @param msg 
     * @param args 
     * @param db 
     * @returns 
     */
    public static execute(msg: Message, args: Array<string>, db: Database) {
        if(args.length !== 1) {
            msg.channel.send(Roadmap.usage).catch(console.error);
            return;
        }

        // const officer = msg.guild.roles.cache.find(role => role.name === 'Officer');
        // if(officer && !msg.member.roles.highest.comparePositionTo(officer)) {
        //     // inufficient privileges
        //     return;
        // }

        switch(args[0]) {
            case 'pull':
                Roadmap.lookup([], msg, db);
                break;
            case 'compare':
                Roadmap.compare([], msg, db);
                break;
            case 'teams':
                // TODO display current work being done based on team start/end dates from timeAllocations_diff table
                console.log("!roadmap teams not implemented yet");
                break;
            default:
                msg.channel.send(Roadmap.usage).catch(console.error);
                break;
        }
    }

    /**
     * 
     * @param data 
     * @param type 
     * @returns 
     */
    private static async getResponse(data, type): Promise<any> {
        return await new Promise((resolve, reject) => {
            const req = https.request(Roadmap.options, (res) => {
              let data = '';

              res.on('data', (d) => {
                data += d;
              });
              res.on('end', () => {
                if(data[0] === '<') {
                    console.log(data);
                    reject('Server error');
                }
                switch(type){
                    case 1: // Deliverables
                        resolve(JSON.parse(data).data.progressTracker.deliverables);
                        break;
                    case 2: // Teams
                        resolve(JSON.parse(data).data.progressTracker.teams);
                        break;
                    default:
                        reject(`Invalid response query type ${type}`);
                        break;
                }
              });
            });

            req.on('error', (error) => {
              reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                reject('timed out');
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * 
     * @param offset 
     * @param limit 
     * @param sortBy 
     * @param projectSlugs 
     * @param categoryIds 
     * @returns 
     */
    private static deliverablesQuery(offset: number =0, limit: number=20, sortBy=Roadmap.SortByEnum.ALPHABETICAL, projectSlugs=[], categoryIds=[]) {
        let query: any = {
            operationName: "deliverables",
            query: Roadmap.deliverablesGraphql,
            variables: {
                "startDate": "2020-01-01",
                "endDate": "2023-12-31",
                "limit": limit,
                "offset": offset,
                "sortBy": `${sortBy}`
            }
        };

        if(projectSlugs.length) {
            query.projectSlugs = JSON.stringify(projectSlugs);
        }

        if(categoryIds.length) {
            query.categoryIds = JSON.stringify(categoryIds);
        }

        return JSON.stringify(query);
    }

    /**
     * 
     * @param offset 
     * @param deliverableSlug 
     * @param sortBy 
     * @returns 
     */
    private static teamsQuery(offset: number =0, deliverableSlug: String, sortBy=Roadmap.SortByEnum.ALPHABETICAL) {
        let query: any = {
            operationName: "teams",
            query: Roadmap.teamsGraphql,
            variables: {
                "startDate": "2020-01-01",
                "endDate": "2050-12-31",
                "limit": 20,
                "offset": offset,
                "sortBy": `${sortBy}`,
                "deliverableSlug": deliverableSlug,
            }
        };

        return JSON.stringify(query);
    }

    /**
     * 
     * @param argv 
     * @param msg 
     * @param db 
     */
    private static async lookup(argv: Array<string>, msg: Message, db: Database) {
        msg.channel.send('Retrieving roadmap state...').catch(console.error);
        let start = Date.now();
        let deliverables = [];
        let offset = 0;
        const sortBy = 'd' in argv ? Roadmap.SortByEnum.CHRONOLOGICAL : Roadmap.SortByEnum.ALPHABETICAL;
        let completedQuery = true;
        const initialResponse = await Roadmap.getResponse(Roadmap.deliverablesQuery(offset, 1, sortBy), Roadmap.QueryTypeEnum.Deliverables).catch((e) => {
            completedQuery = false;
        }); // just needed for the total count; could speed up by only grabbing this info and not the rest of the metadata
        let deliverablePromises = [];

        do {
            deliverablePromises.push(Roadmap.getResponse(Roadmap.deliverablesQuery(offset, 20, sortBy), Roadmap.QueryTypeEnum.Deliverables).catch(() => completedQuery = false));
            offset += 20;
        } while(offset < initialResponse.totalCount)

        Promise.all(deliverablePromises).then((responses)=>{
            if(!completedQuery) {
                return msg.channel.send(`Roadmap retrieval timed out; please try again later.`).catch(console.error);
            }

            let teamPromises = [];
            responses.forEach((response)=>{
                let metaData = response.metaData;
                deliverables = deliverables.concat(metaData);
            });

            // only show tasks that complete in the future
            if('n' in argv) {
                const now = Date.now();
                deliverables = deliverables.filter(d => new Date(d.endDate).getTime() > now);
            }

            // only show tasks that have expired or been completed
            if('o' in argv) {
                const now = Date.now();
                deliverables = deliverables.filter(d => new Date(d.endDate).getTime() <= now);
            }

            // sort by soonest expiring
            if('e' in argv) {
                deliverables.sort((a,b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime() || new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
            }

            // download and attach development team time assignments to each deliverable
            deliverables.forEach((d) => {
                teamPromises.push(Roadmap.getResponse(Roadmap.teamsQuery(offset, d.slug), Roadmap.QueryTypeEnum.Teams).catch(() => completedQuery = false));
            });

            Promise.all(teamPromises).then(async (responses) => {
                if(!completedQuery) {
                    return msg.channel.send(`Roadmap team retrieval timed out; please try again later.`).catch(console.error);
                }
                responses.forEach((response, index)=>{
                    // order is preserved, team index matches deliverable index
                    let metaData = response.metaData;
                    deliverables[index].teams = metaData;
                });

                let delta = Date.now() - start;
                console.log(`Deliverables: ${deliverables.length} in ${delta} milliseconds`);
                msg.channel.send(`Roadmap retrieval returned ${deliverables.length} deliverables in ${delta} ms. Type \`!roadmap compare\` to compare to the last update!`).catch(console.error);

                const compareTime = Date.now();

                // populate db with initial values
                let deliverableDeltas = db.prepare("SELECT COUNT(*) as count FROM deliverable_diff").get();
                if(!deliverableDeltas.count) {
                    
                    const initializationDataDir = path.join(__dirname, '..', 'initialization_data');
                    fs.readdirSync(initializationDataDir).forEach((file) => {
                        const year = +file.substring(0, 4);
                        const month = +file.substring(4, 6);
                        const day = +file.substring(6, 8);
                        const date = new Date(year, month - 1, day).getTime();
                        const data = JSON.parse(fs.readFileSync(path.join(initializationDataDir, file), 'utf-8'));
                        Roadmap.insertChanges(db, date, Roadmap.adjustData(data));
                    });
                }

                Roadmap.insertChanges(db, compareTime, Roadmap.adjustData(deliverables));
                console.log(`Database updated with delta in ${Date.now() - compareTime} ms`);

                // const dbDate = new Date(start).toISOString().split("T")[0].replace(/-/g,'');
                // const existingRoadmap: any = db.prepare('SELECT * FROM roadmap ORDER BY date DESC').get();
                // const newRoadmap = JSON.stringify(deliverables, null, 2)

                // let insert = !existingRoadmap;

                // if(existingRoadmap) {
                //     insert = !_.isEqual(existingRoadmap.json, newRoadmap);
                // }

                // // TODO remove true
                // if(insert||true) {
                //     db.prepare("INSERT OR REPLACE INTO roadmap (json, date) VALUES (?,?)").run([newRoadmap, dbDate]);
                //     msg.channel.send(`Roadmap retrieval returned ${deliverables.length} deliverables in ${delta} ms. Type \`!roadmap compare\` to compare to the last update!`).catch(console.error);
                //     await Roadmap.compare([], msg, db, true);
                // } else {
                //     msg.channel.send('No changes have been detected since the last pull.').catch(console.error);
                // }
            }).catch(console.error);
        }).catch(console.error);
    }

    /**
     * 
     * @param deliverables 
     * @returns 
     */
    private static adjustData(deliverables: any[]): any[] { // adjust the deliverable object for db insertion
        deliverables.forEach((d)=>{
            d.startDate = Date.parse(d.startDate);
            d.endDate = Date.parse(d.endDate);
            d.updateDate = Date.parse(d.updateDate);
            if(d.card) {
                d.card.tid = d.card.id,
                d.card.release_id = d.card.release.id;
                d.card.release_title = d.card.release.title;
                d.card.updateDate = Date.parse(d.card.updateDate);
                delete(d.card.id);
            }
            if(d.teams) {
                d.teams.forEach((team) => {
                    if(team.timeAllocations) {
                        team.timeAllocations.forEach((ta) => {
                            ta.startDate = Date.parse(ta.startDate);
                            ta.endDate = Date.parse(ta.endDate);
                        });
                    }
                });
            }
        });
        return deliverables;
    }

    /**
     * 
     * @param argv 
     * @param msg 
     * @param db 
     * @returns 
     */
    private static async compare(argv: Array<string>, msg: Message, db: Database) {
        // TODO add start/end filter
        msg.channel.send('Calculating differences between roadmaps...').catch(console.error);
        const results: any = db.prepare('SELECT * FROM roadmap ORDER BY date DESC LIMIT 2').all();
        if(!results || results.length < 2) {
            msg.channel.send('More than one roadmap snapshot is needed to compare. Pull and try again later.').catch(console.error);
            return;
        }

        const lastUpdate = db.prepare("SELECT MAX(addedDate) as date FROM deliverable_diff").get();

        const first = JSON.parse(results[1].json);
        const last = JSON.parse(results[0].json);

        const compareTime = Date.now();

        let messages = [];

        const removedDeliverables = first.filter(f => !last.some(l => l.uuid === f.uuid || (f.title && f.title === l.title && !f.title.includes("Unannounced"))));
        if(removedDeliverables.length) {
            messages.push(`[${removedDeliverables.length}] deliverable(s) *removed*:\n`);
            removedDeliverables.forEach(d => {
                // mark previous timespan
                messages.push(he.unescape(`\* ${d.title}\n`.toString()));
                messages.push(he.unescape(Roadmap.shortenText(`${d.description}\n`)));
                // removed deliverable implies associated time allocations were removed; no description necessary
            });
            messages.push('===================================================================================================\n\n');
        }

        const newDeliverables = last.filter(l => !first.some(f => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))));
        if(newDeliverables.length) {
            messages.push(`[${newDeliverables.length}] deliverable(s) *added*:\n`);
            newDeliverables.forEach(d => {
                const start = new Date(d.startDate).toDateString();
                const end = new Date(d.endDate).toDateString();
                messages.push(he.unescape(`\* **${d.title.trim()}**\n`.toString()));
                messages.push(he.unescape(`${start} => ${end}\n`.toString()));
                messages.push(he.unescape(Roadmap.shortenText(`${d.description}\n`)));

                // todo - new teams, etc
                // check for diffs in each list
                if(d.card) {
                    let card = {

                    };
                    let sner = card;
                    //reamainingCards.push(card);
                }

                if(d.teams) {
                    d.teams.forEach((t)=>{
                        //t.timeAllocations
                    });
                }
            });
            messages.push('===================================================================================================\n\n');
        }

        const remainingDeliverables = first.filter(f => last.some(l => l.uuid === f.uuid || l.title === f.title));
        let updatedDeliverables = [];
        if(remainingDeliverables.length) {
            let updatedMessages = [];
            remainingDeliverables.forEach(f => {
                const l = last.find(x => x.uuid === f.uuid || (f.title && x.title === f.title && !f.title.includes("Unannounced")));
                const d = diff.getDiff(f, l);
                if(d.length && l) {
                    const changes = d.map(x => ({op: x.op, change: x.path && x.path[0], val: x.val}));

                    if(changes.some(p => p.op === 'update' && (p.change === 'endDate' || p.change === 'startDate' || p.change === 'title' || p.change === 'description'))) {
                        const title = f.title === 'Unannounced' ? `${f.title} (${f.description})` : f.title;
                        let update = `\* **${title}**\n`;

                        if(changes.some(p => p.change === 'startDate')) {
                            const oldDate = new Date(f.startDate);
                            const oldDateText = oldDate.toDateString();
                            const newDate = new Date(l.startDate);
                            const newDateText = newDate.toDateString();

                            let updateText = "";
                            if(Date.parse(oldDateText) < compareTime && Date.parse(newDateText) < compareTime) {
                                updateText = "been corrected"; // shift in either direction is most likely a time allocation correction
                            } else if(newDate < oldDate) {
                                updateText = "moved closer";
                            } else if(oldDate < newDate) {
                                updateText = "pushed back";
                            }

                            update += `Start date has ${updateText} from ${oldDateText} to ${newDateText}\n`;
                        }
                        if(changes.some(p => p.change === 'endDate')) {
                            const oldDate = new Date(f.endDate);
                            const oldDateText = oldDate.toDateString();
                            const newDate = new Date(l.endDate);
                            const newDateText = newDate.toDateString();

                            let updateText = "";
                            if(compareTime < Date.parse(oldDateText) && Date.parse(newDateText) < compareTime) {
                                updateText = "moved earlier (time allocation removal(s) likely)\n"; // likely team time allocation was removed, but could have finished early
                            } else if(oldDate < newDate) {
                                updateText = "been extended";
                            } else if(newDate < oldDate) {
                                updateText = "moved closer";
                            }

                            update += `End date has ${updateText} from ${oldDateText} to ${newDateText}\n`;
                        }

                        if(changes.some(p => p.change === 'title')) {
                            update += Roadmap.shortenText(`Title has been updated from "${f.title}" to "${l.title}"`);
                        }
                        if(changes.some(p => p.change === 'description')) {
                            update += Roadmap.shortenText(`Description has been updated from\n"${f.description}"\nto\n"${l.description}"`);
                        }
                        updatedMessages.push(he.unescape(update + '\n'));
                        updatedDeliverables.push(f);
                    }
                }
            });
            messages.push(`[${updatedDeliverables.length}] deliverable(s) *updated*:\n`);
            messages = messages.concat(updatedMessages);
            messages.push(`[${remainingDeliverables.length - updatedDeliverables.length}] deliverable(s) *unchanged*`);
        }

        await msg.channel.send({files: [new MessageAttachment(Buffer.from(messages.join(''), "utf-8"), `roadmap_${results[0].date}.md`)]}).catch(console.error);
    }

    /**
     * Shortens text to 100 characters per line for discord display
     * @param text The text to shorten
     * @returns The shortened text
     */ 
    private static shortenText(text): string {
        return `${text.replace(/(?![^\n]{1,100}$)([^\n]{1,100})\s/g, '$1\n')}\n`.toString();
    }

    /** 
     * Generate delta entries for each deliverable 
     * @param db The database connection 
     * @param now The time to use for addedTime entries
     * @param deliverables The deliverable entries to add
     */
    private static insertChanges(db: Database, now: number, deliverables: any[]) {
        const deliverableInsert = db.prepare("INSERT INTO deliverable_diff (uuid, slug, title, description, addedDate, numberOfDisciplines, numberOfTeams, totalCount, card_id, project_ids, startDate, endDate, updateDate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
        const cardsInsert = db.prepare("INSERT INTO card_diff (tid, title, description, category, release_id, release_title, updateDate, addedDate, thumbnail) VALUES (?,?,?,?,?,?,?,?,?)");
        const teamsInsert = db.prepare("INSERT INTO team_diff (abbreviation, title, description, startDate, endDate, addedDate, numberOfDeliverables, slug) VALUES (?,?,?,?,?,?,?,?)");
        const deliverableTeamsInsert = db.prepare("INSERT INTO deliverable_teams (deliverable_id, team_id) VALUES (?,?)");
        const timeAllocationInsert = db.prepare("INSERT INTO timeAllocation_diff (startDate, endDate, addedDate, uuid, partialTime, team_id, deliverable_id) VALUES (?,?,?,?,?,?,?)");

        // filter out deliverables that had their uuids changed, except for unnanounced content (we don't know if one content is the same as another if their uuid changes)
        let dbDeliverables = db.prepare("SELECT *, MAX(addedDate) FROM deliverable_diff GROUP BY uuid ORDER BY addedDate DESC").all();
        const announcedDeliverables = _._(dbDeliverables.filter(d => d.title && !d.title.includes("Unannounced"))).groupBy('title').map(d => d[0]).value();//.flatMap(d => d[0]);
        const unAnnouncedDeliverables = dbDeliverables.filter(d => d.title && d.title.includes("Unannounced"));
        dbDeliverables = [...announcedDeliverables, ...unAnnouncedDeliverables];

        let dbTeams = db.prepare("SELECT *, MAX(addedDate) FROM team_diff GROUP BY slug").all();
        const mostRecentDeliverableIds = dbDeliverables.map((dd) => dd.id).toString();
        const dbDeliverableTeams = db.prepare(`SELECT * FROM team_diff WHERE id IN (SELECT team_id FROM deliverable_teams WHERE deliverable_id IN (${mostRecentDeliverableIds}))`).all();
        const dbCards = db.prepare("SELECT *, MAX(addedDate) FROM card_diff GROUP BY tid").all();
        let dbTimeAllocations = db.prepare("SELECT *, MAX(addedDate) FROM timeAllocation_diff GROUP BY uuid");
 
        // teams from deliverables -> db.prepare("SELECT * FROM team_diff WHERE id IN (SELECT team_id FROM deliverable_teams WHERE deliverable_id IN (SELECT id FROM deliverable_diff WHERE uuid = '[uuid here]' ORDER BY addedDate DESC LIMIT 1))").all();

        const dbRemovedDeliverables = dbDeliverables.filter(d => d.startDate === null && d.endDate === null);
        const removedDeliverables = dbDeliverables.filter(f => !deliverables.some(l => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))) &&
            !dbRemovedDeliverables.some(l => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))));

        const insertTeamsAndTimeAllocations = (teams: any[], justIds: boolean = true): any => {
            let rTeams = [];
            let rTimes = [];
            if(teams) {
                teams.forEach((dt) => {
                    const match = dbTeams.find(t => t.slug === dt.slug);
                    const tDiff = diff.getDiff(match, dt).filter((df) => df.op === 'update');
                    let teamId = null;
                    if(tDiff.length || !match) { // new or changed
                        const teamRow = teamsInsert.run([dt.abbreviation, dt.title, dt.description, dt.startDate, dt.endDate, now, dt.numberOfDeliverables, dt.slug]);
                        teamId = teamRow.lastInsertRowid;
                        if(justIds) {
                            rTeams.push(teamId);
                        } else {
                            rTeams.push({id: teamId, ...dt});
                        }
                    } else {
                        teamId = match.id;
                        rTeams.push(teamId);
                    }

                    // analyze changes to time allocations
                    if(dt.timeAllocations) {
                        dt.timeAllocations.forEach((ta) => {
                            const taMatch = dbTimeAllocations.find(t => t.uuid === ta.uuid);
                            const taDiff = diff.getDiff(taMatch, ta);
                            if(taDiff.length || !taMatch) {
                                rTimes.push({team_id: teamId, ...ta});
                            } else {
                                rTimes.push({team_id: teamId, ...taMatch});
                            }
                        });
                    }
                });
            }
            return {teams: rTeams, timeAllocations: rTimes};
        }

        const insertDeliverables = db.transaction((dList: [any]) => {
            // check for team differences
            const dTeams = _.uniqBy(dList.filter((d) => d.teams).flatMap((d) => d.teams).map((t)=>_.omit(t, 'timeAllocations', 'uuid')), 'slug');
            if(dbTeams.length) {
                const dbRemovedTeams = dbTeams.filter(t => t.startDate === null && t.endDate === null);
                const removedTeams = dbTeams.filter(f => !dTeams.some(l => l.slug === f.slug) && !dbRemovedTeams.some(l => l.slug === f.slug))
                removedTeams.forEach((rt) => {
                    teamsInsert.run([rt.abbreviation, rt.title, rt.description, null, null, now, rt.numberOfDeliverables, rt.slug]);
                });
            } else { // initialize team_diff
                const inserts = insertTeamsAndTimeAllocations(dTeams, false); // changes to teams or time allocations
                dbTeams = inserts.teams;
                dbTimeAllocations = inserts.timeAllocations;
            }

            if(dbTimeAllocations.length) {
                const dbRemovedTimeAllocations = dbTimeAllocations.filter(ta => ta.startDate === null && ta.endDate === null && ta.partialTime === null);
                const dTimes = dList.filter((d) => d.teams).flatMap((d) => d.teams).flatMap((t) => t.timeAllocations);
                const removedTimes = dbTimeAllocations.filter(f => !dTimes.some(l => l.uuid === f.uuid) && !dbRemovedTimeAllocations.some(l => l.uuid === f.uuid));
                removedTimes.forEach((rt) => {
                    timeAllocationInsert.run([null, null, now, rt.uuid, null, rt.team_id, rt.deliverable_id]);
                });
            }

            if(dbCards.length) {
                const dCards = dList.filter((d) => d.card).flatMap((d) => d.card);
                const dbRemovedCards = dbCards.filter(f => f.updateDate === null && f.release_id === null && f.release_title === null);
                const removedCards = dbCards.filter(f => !dCards.some(l => l.tid === f.tid) && !dbRemovedCards.some(l => l.tid === f.tid));
                removedCards.forEach((rc) => {
                    cardsInsert.run([rc.tid, rc.title, rc.description, rc.category, null, null, null, now, rc.thumbnail]);
                });
            }

            removedDeliverables.forEach((r) => {
                deliverableInsert.run([r.uuid, r.slug, r.title, r.description, now, null, null, r.totalCount, null, null, null, null, null]);
            });

            let addedCards = []; // some deliverables share the same release view card (ie. 'Bombs' and 'MOAB')
            dList.forEach((d) => {
                const dMatch = dbDeliverables.find((dd) => dd.uuid === d.uuid || (d.title && dd.title === d.title && !d.title.includes("Unannounced")));
                const gd = diff.getDiff(dMatch, d).filter((df) => df.op === 'update');

                if(gd.length || !dMatch || !dbDeliverableTeams.length) {
                    const changes = gd.map(x => ({change: x.path && x.path[0], val: x.val}));
                    let team_ids = [];
                    let timeAllocations = [];
                    let card_id = null;
                    if(gd.length && changes.some((c) => c.change === 'numberOfTeams' || c.change === 'startDate' || c.change === 'endDate') || (!dMatch && d.teams) || !dbDeliverableTeams.length) {
                        const inserts = insertTeamsAndTimeAllocations(d.teams); // changes to teams or time allocations
                        team_ids = inserts.teams;
                        timeAllocations = inserts.timeAllocations; // updated time allocations
                    }

                    if(d.card) {
                        const cMatch = dbCards.find((dc) => dc.tid === d.card.tid);
                        const cgd = diff.getDiff(cMatch, d.card).filter((df) => df.op === 'update');
                        if(!cMatch || cgd.length) {
                            const sharedCard = addedCards.find(c => c.tid === d.card.tid);
                            if(sharedCard) {
                                card_id = sharedCard.id;
                            } else {
                                const row = cardsInsert.run([d.card.tid, d.card.title, d.card.description, d.card.category, d.card.release_id, d.card.release_title, d.card.updateDate, now, d.card.thumbnail]);
                                card_id = row.lastInsertRowid;
                                addedCards.push({tid: d.card.tid, id: card_id});
                            }
                        } else {
                            card_id = cMatch.id;
                        }
                    }

                    const projectIds = d.projects.map(p => { return p.title === 'Star Citizen' ? 'SC' : (p.title === 'Squadron 42' ? 'SQ42' : null); }).toString();

                    let did = null;
                    if(!dMatch || (dMatch && gd.length)) {
                        const row = deliverableInsert.run([d.uuid, d.slug, d.title, d.description, now, d.numberOfDisciplines, d.numberOfTeams, d.totalCount, card_id, projectIds, d.startDate, d.endDate, d.updateDate]);
                        did = row.lastInsertRowid;
                    } else {
                        did = dMatch.id;
                    }

                    team_ids.forEach((tid) => {
                        deliverableTeamsInsert.run([did, tid]);
                    });

                    timeAllocations.forEach((ta) => {
                         timeAllocationInsert.run([ta.startDate, ta.endDate, now, ta.uuid, ta.partialTime?1:0, ta.team_id, did]);
                    });
                }

            });
        });

        insertDeliverables(deliverables);
    }
}