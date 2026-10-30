const randomFeedBotDelay = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const findFeedBotTankUpgradePath = targetTank => {
    if (!targetTank || targetTank === "basic") return [];
    const pending = [{ tank: "basic", path: [] }];
    const seen = new Set(["basic"]);
    while (pending.length) {
        const current = pending.shift();
        const definition = Class[current.tank];
        if (!definition) continue;
        for (let tier = 1; tier <= 4; tier++) {
            const upgrades = definition[`UPGRADES_TIER_${tier}`] ?? [];
            for (const upgrade of upgrades) {
                const candidates = Array.isArray(upgrade) ? upgrade.filter(name => typeof name === "string") : [upgrade];
                for (const tank of candidates) {
                    if (typeof tank !== "string" || !Class[tank]) continue;
                    const path = [...current.path, { tank, tier }];
                    if (tank === targetTank) return path;
                    if (seen.has(tank)) continue;
                    seen.add(tank);
                    pending.push({ tank, path });
                }
            }
        }
    }
    return null;
};

class gameHandler {
    constructor() {
        this.loopCounter = 0;
        this.loophealCounter = 0;
        this.bots = [];
        this.feedBots = [];
        this.feedBotIndices = new Map();
        this.foods = [];
        this.nestFoods = [];
        this.enemyFoods = [];
        this.auraCollideTypes = ["miniboss", "tank", "food", "crasher"]
        this.naturallySpawnedBosses = [];
        this.bossTimer = 0;
        this.active = false;
    }
    addFeedBot(bot) {
        if (this.feedBotIndices.has(bot.id)) return;
        this.feedBotIndices.set(bot.id, this.feedBots.length);
        this.feedBots.push(bot);
    }
    removeFeedBot(bot) {
        const index = this.feedBotIndices.get(bot.id);
        if (index === undefined) return;
        const lastIndex = this.feedBots.length - 1;
        const lastBot = this.feedBots[lastIndex];
        if (index !== lastIndex) {
            this.feedBots[index] = lastBot;
            this.feedBotIndices.set(lastBot.id, index);
        }
        this.feedBots.pop();
        this.feedBotIndices.delete(bot.id);
    }
    startFeedBotProgression(bot, targetTank, skillBuild) {
        let upgradePath = findFeedBotTankUpgradePath(targetTank);
        if (upgradePath === null) upgradePath = [{ tank: targetTank, tier: 3, force: true }];
        upgradePath = upgradePath.map(step => ({
            ...step,
            force: step.force || Config.tier_multiplier * step.tier > 42
        }));
        bot.feedBotProgression = {
            maxLevel: 42,
            skillBuild: skillBuild.slice(),
            upgradePath,
            upgradeIndex: 0,
            nextSkillAt: null,
            nextTankUpgradeAt: null
        };
        while (bot.skill.level < 42) {
            bot.skill.score += bot.skill.levelScore;
            bot.skill.maintain();
        }
        bot.refreshBodyAttributes();
    }
    updateFeedBotProgression(now = Date.now()) {
        for (const bot of this.feedBots) {
            const progression = bot.feedBotProgression;
            if (!progression || bot.isDead()) continue;

            const upgradeStep = progression.upgradePath[progression.upgradeIndex];
            if (upgradeStep && bot.skill.level >= Math.min(progression.maxLevel, Config.tier_multiplier * upgradeStep.tier)) {
                if (progression.nextTankUpgradeAt === null) {
                    progression.nextTankUpgradeAt = now + randomFeedBotDelay(
                        Config.feed_bot_tank_upgrade_delay_min_ms,
                        Config.feed_bot_tank_upgrade_delay_max_ms
                    );
                }
                if (now >= progression.nextTankUpgradeAt) {
                    const upgradeIndex = bot.upgrades.findIndex(upgrade => {
                        const candidates = Array.isArray(upgrade.class) ? upgrade.class : [upgrade.class];
                        return candidates.includes(upgradeStep.tank);
                    });
                    let upgraded = upgradeIndex >= 0 && bot.upgrade(upgradeIndex, bot.upgrades[upgradeIndex].branch, true);
                    if (!upgraded && upgradeStep.force) {
                        bot.define(upgradeStep.tank);
                        upgraded = true;
                    }
                    if (upgraded) {
                        bot.refreshBodyAttributes();
                        progression.upgradeIndex++;
                        progression.nextTankUpgradeAt = null;
                    } else {
                        progression.nextTankUpgradeAt = now + 500;
                    }
                }
            }

            if (!progression.skillBuild.length || !bot.skill.points) {
                progression.nextSkillAt = null;
                continue;
            }
            if (progression.nextSkillAt === null) {
                progression.nextSkillAt = now + randomFeedBotDelay(
                    Config.feed_bot_skill_delay_min_ms,
                    Config.feed_bot_skill_delay_max_ms
                );
            }
            if (now >= progression.nextSkillAt) {
                const availableStats = progression.skillBuild.filter(stat => bot.skill.amount(stat) < bot.skill.cap(stat));
                if (!availableStats.length) {
                    progression.nextSkillAt = null;
                    continue;
                }
                bot.skillUp(availableStats[Math.floor(Math.random() * availableStats.length)]);
                progression.nextSkillAt = bot.skill.points
                    ? now + randomFeedBotDelay(Config.feed_bot_skill_delay_min_ms, Config.feed_bot_skill_delay_max_ms)
                    : null;
            }
        }
    }
    checkUsers = () => global.gameManager.clients.length >= 1;
    // Collision stuff
    collide = (instance, other) => {

        // Feed bots and their own projectiles never need to collide with one another.
        const instanceFeedBot = instance.isFeedBot ? instance : instance.master?.isFeedBot ? instance.master : null;
        const otherFeedBot = other.isFeedBot ? other : other.master?.isFeedBot ? other.master : null;
        // Bots owned by one player form a group; their internal collisions add cost but do not help gameplay.
        if (instanceFeedBot && otherFeedBot && instanceFeedBot.master === otherFeedBot.master) return 0;

        // Fast exit for noclip or ghosts
        if (instance.noclip || other.noclip) return 0;

        // Emit collision events
        instance.emit("collide", { body: instance, instance, other });
        other.emit("collide", { body: other, instance: other, other: instance });
        // Custom tick handlers for bullet entities
        if (instance.tickHandler) instance.tickHandler(instance, instance, other);
        if (other.tickHandler) other.tickHandler(other, other, instance);

        if (instance.settings.no_collisions || 
            instance.master.master.settings.no_collisions || 
            other.settings.no_collisions || 
            other.master.master.settings.no_collisions
        )  return 0;

        // Ghost checks (merged for less code repetition)
        for (const obj of [instance, other]) {
            if (obj.isGhost || obj.isDead()) {
                if (obj.isInGrid) {
                    obj.destroy();
                }
                return 0;
            }
        }

        // Fast exit for inactive or invisible entities
        if (
            (instance.isArenaCloser && !instance.alpha) ||
            (other.isArenaCloser && !other.alpha)
        ) return 0;

        // Fast exit for wall-vs-wall with never-collide
        if (
            instance.settings.hitsOwnType === "never" &&
            other.settings.hitsOwnType === "never" &&
            instance.team === other.team &&
            instance.type === "wall" && other.type === "wall"
        ) return;
        switch (true) {
            case instance.isPortal || other.isPortal:
                let [portal, otherBody] = instance.isPortal ? [instance, other] : [other, instance];

                if (portal.settings.destination && otherBody.isPlayer && otherBody.socket) {
                    global.gameManager.socketManager.sendToServer(otherBody.socket, portal.settings.destination, portal.settings.destinationId);
                } else if (["bullet", "drone", "trap", "satellite"].includes(otherBody.type)) {
                    if (otherBody.master !== portal) otherBody.kill();
                } else if (!["wall", "aura"].includes(otherBody.type)) advancedcollide(portal, otherBody, false, false);
                break;
            case instance.type === "wall" || other.type === "wall":
                if (instance.type === "wall" && other.type === "wall") return;
                if (instance.type === "aura" || other.type === "aura") return;
                if (instance.type === "satellite" || other.type === "satellite") return;
                let wall = instance.type === "wall" ? instance : other;
                let entity = instance.type === "wall" ? other : instance;
                if (entity.isArenaCloser || (entity.isArenaCloser !== false && entity.master.isArenaCloser)) return;
                switch (wall.shape) {
                    case 4:
                        switch (wall.walltype) {
                            case 1:
                                mazewallcollide(wall, entity);
                                break;
                            default:
                                mazewallcustomcollide(wall, entity);
                                break;
                        }
                        break;
                    default:
                        mooncollide(wall, entity);
                        break;
                }
                break;
            case instance.team === other.team &&
                (instance.settings.hitsOwnType === "pushOnlyTeam" ||
                    other.settings.hitsOwnType === "pushOnlyTeam"):
                {
                    let pusher = instance.settings.hitsOwnType === "pushOnlyTeam" ? instance : other;
                    let entity = instance.settings.hitsOwnType === "pushOnlyTeam" ? other : instance;
                    // Dominator / Mothership collisions
                    if (
                        instance.settings.hitsOwnType === other.settings.hitsOwnType ||
                        entity.settings.hitsOwnType === "never"
                    ) return;
                    let a = 1 + 10 / (Math.max(entity.velocity.length, pusher.velocity.length) + 10);
                    advancedcollide(pusher, entity, false, false, a);
                }
                break;
            case instance.team === other.team &&
                (instance.settings.hitsOwnType === "droneCollision" &&
                    other.settings.hitsOwnType === "droneCollision"):
                {
                    let a = 1 + 10 / (Math.max(instance.velocity.length, other.velocity.length));
                    firmcollide(instance, other, a);
                }
                break;
            case (instance.type === "crasher" && other.type === "food" && instance.team === other.team) ||
                (other.type === "crasher" && instance.type === "food" && other.team === instance.team):
                firmcollide(instance, other);
                break;
            case instance.team !== other.team ||
                (instance.team === other.team && (instance.healer && instance.master.id !== other.id) || (other.healer && other.master.id !== instance.id)):
                // Exits if the aura is not hitting a boss, tank, food, or crasher
                if (instance.type === "aura") {
                    if (!(this.auraCollideTypes.includes(other.type))) return;
                } else if (other.type === "aura") {
                    if (!(this.auraCollideTypes.includes(instance.type))) return;
                }
                advancedcollide(instance, other, true, true);
                break;
            case instance.settings.hitsOwnType == "never" ||
                other.settings.hitsOwnType == "never":
                break;
            case instance.settings.hitsOwnType === other.settings.hitsOwnType:
                switch (instance.settings.hitsOwnType) {
                    case "assembler": {
                        if (instance.assemblerLevel == null) instance.assemblerLevel = 1;
                        if (other.assemblerLevel == null) other.assemblerLevel = 1;
                        const [target1, target2] = (instance.id > other.id) ? [instance, other] : [other, instance];
                        if (
                            target2.assemblerLevel >= 10 || target1.assemblerLevel >= 10 ||
                            target1.isDead() || target2.isDead() ||
                            (target1.parent.id !== target2.parent.id &&
                                target1.parent.id != null &&
                                target2.parent.id != null)
                        ) {
                            advancedcollide(instance, other, false, false); // continue push
                            break;
                        }
                        const better = (state) => (target1[state] > target2[state] ? target1[state] : target2[state]);
                        target1.assemblerLevel = Math.min(target2.assemblerLevel + target1.assemblerLevel, 10);
                        target1.SIZE = better("SIZE") * 1.15;
                        target1.SPEED = better("SPEED") * 0.9;
                        target1.HEALTH = better("HEALTH") * 1.2;
                        target1.health.amount = target1.health.max;
                        target1.DAMAGE = better("DAMAGE") * 1.1;
                        target2.kill();
                        target1.refreshBodyAttributes();
                        for (let i = 0; i < 10; ++i) {
                            const o = new Entity(target1, target1);
                            o.define("assemblerEffect");
                            o.team = target1.team;
                            o.color = target1.color;
                            o.SIZE = target1.SIZE / 1.5;
                            o.velocity = new Vector((Math.random() - 0.5) * 25, (Math.random() - 0.5) * 15);
                            o.refreshBodyAttributes();
                            o.life();
                        }
                    } // don't break
                    case "push":
                        advancedcollide(instance, other, false, false);
                        break;
                    case "hard":
                        firmcollide(instance, other);
                        break;
                    case "hardWithBuffer":
                        firmcollide(instance, other, 30);
                        break;
                    case "hardOnlyTanks":
                        if (
                            instance.type === "tank" &&
                            other.type === "tank" &&
                            !instance.isDominator &&
                            !other.isDominator
                        ) {
                            switch (Config.train) {
                                case true:
                                    firmcollidehard(instance, other, 20);
                                    break;
                                default: 
                                    firmcollide(instance, other);
                                    break;
                            }
                            
                        };
                        break;
                    case "hardOnlyBosses":
                        if (instance.type === other.type && instance.type === "miniboss") {
                            firmcollide(instance, other); 
                        }
                        break;
                    case "repel":
                        simplecollide(instance, other);
                        break;
                }
                break;
        }
    };

    gameloop() {
        logs.loops.tally();
        logs.master.set();

        // Do entities life
        // The profiling below is optional because it adds a performance.now() call
        // per entity per tick.
        const profiling = !!Config.tick_profiling;
        const profile = profiling ? (this.tickProfile ??= { controllers: 0, collision: 0, socket: 0, selfie: 0, physics: 0, lastReport: Date.now(), nextConsoleSample: Date.now() + 5000 }) : null;
        const consoleSample = profiling && Date.now() >= profile.nextConsoleSample;
        if (consoleSample) profile.nextConsoleSample = Date.now() + 5000;
        let timedControllers = false, timedCollision = false;
        logs.entities.set();
        grid.clear();
        for (const instance of entities.values()) {
            if (instance.contemplationOfMortality() === 1) {
                if (Config.outbreak && !instance.zombified && (instance.isPlayer || instance.isBot)) {
                    instance.zombified = true;
                    instance.settings.no_collisions = true;
                    instance.alpha = 0;
                    instance.takeSelfie();
                    Config.outbreak_functions.zombify(instance);
                } else instance.destroy();
                continue;
            }

            // Reset collision array once at the beginning
            instance.collisionArray = [];

            // Handle physics only if not bonded
            if (instance.bond == null) {
                // Resolve the physical behavior from the last collision cycle.
                logs.physics.set();
                const physicsStart = profiling ? performance.now() : 0;
                instance.physics();
                if (profiling) profile.physics += performance.now() - physicsStart;
                logs.physics.mark();
            }

            if (instance.activation.active || instance.isPlayer) {
                logs.entities.tally();
                // Think about my actions.
                logs.life.set();
                const controllerStart = profiling ? performance.now() : 0;
                const timeControllers = consoleSample && !timedControllers;
                if (timeControllers) { console.time("controllers"); timedControllers = true; }
                instance.life();
                if (timeControllers) console.timeEnd("controllers");
                if (profiling) profile.controllers += performance.now() - controllerStart;
                logs.life.mark();
                // Take a selfie.
                logs.selfie.set();
                const selfieStart = profiling ? performance.now() : 0;
                instance.takeSelfie();
                if (profiling) profile.selfie += performance.now() - selfieStart;
                logs.selfie.mark();
                // Apply friction.
                instance.friction();
                instance.confinementToTheseEarthlyShackles();
            }

            // Update axis-aligned bounding box
            instance.updateAABB(instance.activation.active);
            // Check collisions.
            logs.collide.set();
            const collisionStart = profiling ? performance.now() : 0;
            const timeCollision = consoleSample && !timedCollision;
            if (timeCollision) { console.time("collision"); timedCollision = true; }
            for (const other of grid.query(instance.minX, instance.minY, instance.maxX, instance.maxY).values()) {
                this.collide(instance, other);
            }
            if (instance.isInGrid) grid.insert(instance, instance.minX, instance.minY, instance.maxX, instance.maxY);
            if (timeCollision) console.timeEnd("collision");
            logs.collide.mark();
            if (profiling) profile.collision += performance.now() - collisionStart;
            if ((instance.touchingSizeWall === false || instance.collisionArray.length === 0) && instance.originalSize) {
                instance.SIZE = instance.originalSize;
                instance.originalSize = undefined;
            }
            if ((instance.touchingFovWall === false || instance.collisionArray.length === 0) && instance.originalFov) {
                instance.FOV = instance.originalFov;
                instance.originalFov = undefined;
            }
            // Check whether we want to live.
            logs.activation.set();
            instance.activation.update();
            logs.activation.mark();

            instance.emit("tick", { body: instance });
        }
        logs.entities.mark();
        logs.master.mark();
        // Update lastCycle only once
        global.gameManager.room.lastCycle = util.time();
        const socketStart = profiling ? performance.now() : 0;
        if (consoleSample) console.time("socket update");
        for (let i = 0; i < global.gameManager.clients.length; i++) {
            let client = global.gameManager.clients[i];
            if (client.status.readyToBroadcast && global.gameManager.socketManager.canSendUpdate(client)) {
                client.view.gazeUpon();
            }
        }
        if (consoleSample) console.timeEnd("socket update");
        if (profiling) {
            profile.socket = (profile.socket ?? 0) + performance.now() - socketStart;
            if (Date.now() - profile.lastReport >= 5000) {
                const sections = ["controllers", "collision", "socket"];
                const slowest = sections.reduce((a, b) => profile[a] >= profile[b] ? a : b);
                const clientInfo = global.gameManager.clients.map(c => `vis=${c.status.visibleEntities} fields=${c.status.lastPacketBytes} inflight=${c.status.receiving}`).join(" | ");
                console.log(`[tick profile 5s] slowest=${slowest} controllers=${profile.controllers.toFixed(1)}ms collision=${profile.collision.toFixed(1)}ms socket=${profile.socket.toFixed(1)}ms selfie=${profile.selfie.toFixed(1)}ms physics=${profile.physics.toFixed(1)}ms entities=${entities.size} feedBots=${this.feedBots.length} ${clientInfo}`);
                profile.controllers = profile.collision = profile.socket = profile.selfie = profile.physics = 0;
                profile.lastReport = Date.now();
            }
        }
    };

    foodloop() {
        if (global.gameManager.arenaClosed) return;

        // Helper to pick a type from a weighted set
        const pickFromChanceSet = (set) => {
            while (Array.isArray(set)) {
                set = set[ran.chooseChance(...set.map(e => e[0]))][1];
            }
            return set;
        };

        // Helper to spawn a food entity
        const spawnFoodEntity = (tile, layeredSet) => {
            const o = new Entity(tile);
            const type = pickFromChanceSet(layeredSet);
            o.define(type);
            o.facing = ran.randomAngle();
            o.team = TEAM_ENEMIES;
            o.isFood = true;
            return o;
        };

        if (Math.random() >= 0.1) return; // 1/10 chance to spawn food

        let totalFoods = 1;
        if (Math.random() < 0.2) { // 1/5 chance to spawn a group
            totalFoods = 1 + Math.floor(Math.random() * Config.food_group_cap);
        }

        // Helper for cleanup interval
        const setupCleanup = (arr, o) => {
            const loop = setInterval(() => {
                if (o.isDead()) {
                    util.remove(arr, arr.indexOf(o));
                    clearInterval(loop);
                }
            }, 1500);
        };

        // Nest food/enemy spawn
        if (Math.random() < 1 / 3 && global.gameManager.room.spawnable[TEAM_ENEMIES]) {
            // Enemy spawn
            if (Config.classic_food && Math.random() < 1 / 3 && this.enemyFoods.length < Config.enemy_cap_nest) {
                const tile = ran.choose(global.gameManager.room.spawnable[TEAM_ENEMIES]).randomInside();
                const o = spawnFoodEntity(tile, Config.classic_enemy_types_nest);
                this.enemyFoods.push(o);
                setupCleanup(this.enemyFoods, o);
            }
            // Nest food spawn
            if (this.nestFoods.length < Config.food_cap_nest) {
                const tile = ran.choose(global.gameManager.room.spawnable[TEAM_ENEMIES]).randomInside();
                for (let i = 0; i < totalFoods; i++) {
                    if (Config.classic_food) {
                        const o = spawnFoodEntity(tile, Config.classic_food_types_nest);
                        this.nestFoods.push(o);
                        setupCleanup(this.nestFoods, o);
                    } else {
                        const o = spawnFoodEntity(tile, Config.food_types_nest);
                        this.nestFoods.push(o);
                        setupCleanup(this.nestFoods, o);
                    }
                }
            }
        } else if (this.foods.length < Config.food_cap) {
            // Regular food spawn
            const tile = ran.choose(global.gameManager.room.spawnableDefault).randomInside();
            for (let i = 0; i < totalFoods; i++) {
                if (Config.classic_food) {
                    const o = spawnFoodEntity(tile, Config.classic_food_types);
                    this.foods.push(o);
                    setupCleanup(this.foods, o);
                } else {
                    const o = spawnFoodEntity(tile, Config.food_types);
                    this.foods.push(o);
                    setupCleanup(this.foods, o);
                }
            }
        }
    }

    regenHealthAndShield() {
        for (let instance of entities.values()) {
            if (instance.shield.max) {
                instance.shield.regenerate();
            }
            if (instance.health.amount) {
                instance.health.regenerate(instance.shield.max && instance.shield.max === instance.shield.amount);
            }
        }
    };
    
    maintainloop = () => {   
    // Upgrade bots' skill
        for (let i = 0; i < this.bots.length; i++) {
            let o = this.bots[i];
            if (o.skill.level < Config.level_cap && o.skill.level >= Config.bot_start_level) {
                o.skill.score += Config.bot_xp_gain;            
            }
        }
        // Spawn bosses
        if (this.checkUsers() && Config.enable_bosses && !this.naturallySpawnedBosses.length && this.bossTimer++ > Config.boss_spawn_cooldown) {
            this.bossTimer = -Config.boss_spawn_delay - 2;
            let selection = Config.boss_types[ran.chooseChance(...Config.boss_types.map((selection) => selection.chance))],
                amount = ran.chooseChance(...selection.amount) + 1;
            if (selection.message) {
                global.gameManager.socketManager.broadcast(selection.message);
            }
            global.gameManager.socketManager.broadcast(amount > 1 ? "Visitors are coming." : "A visitor is coming.");
            setSyncedTimeout(() => {
                let names = ran.chooseBossName(selection.nameType, amount);

                for (let i = 0; i < amount; i++) {
                    let spot, attempts = 30, name = names[i];
                    do {
                        spot = getSpawnableArea(TEAM_ENEMIES, global.gameManager); 
                    } while (attempts-- && dirtyCheck(spot, 500));

                    let boss = new Entity(spot);
                    boss.define(selection.bosses.sort(() => 0.5 - Math.random())[i % selection.bosses.length]);
                    boss.team = TEAM_ENEMIES;
                    boss.isBoss = true;
                    if (name) {
                        boss.name = name;
                    }

                    this.naturallySpawnedBosses.push(boss);
                    boss.on("dead", () => util.remove(this.naturallySpawnedBosses, this.naturallySpawnedBosses.indexOf(boss)));
                }

                global.gameManager.socketManager.broadcast(`${util.listify(names)} ha${names.length == 1 ? "s" : "ve"} arrived!`);
            }, Config.boss_spawn_delay * 30);
        }
    };

    quickMaintainLoop = () => {
        this.updateFeedBotProgression();
    // Auto get score
        for (let i = 0; i < this.bots.length; i++) {
            let o = this.bots[i];
            o.skill.maintain();
            o.skillUp(["atk", "hlt", "spd", "str", "pen", "dam", "rld", "mob", "rgn", "shi"][ran.chooseChance(...Config.bot_skill_upgrade_chances)]);
            o.refreshSkills();
            if (o.leftoverUpgrades && o.upgrade(ran.irandomRange(0, o.upgrades.length))) {
                o.leftoverUpgrades--;
            }
        }
        // Add new bots if arena is open
        if (!global.gameManager.arenaClosed && !global.cannotRespawn && this.bots.length < Config.bot_cap) {
            let team = Config.mode === "tdm" || Config.mode === "tag" ? getWeakestTeam(global.gameManager) : undefined,
                limit = 20, // give up after 20 attempts and just pick whatever is currently chosen
                loc;
            do {
                loc = getSpawnableArea(team, global.gameManager);
            } while (limit-- && dirtyCheck(loc, 50, global.gameManager))

            this.spawnBots(loc, team);
        }
    }

    spawnBots(loc, team) {
        let botName = Config.bot_name_prefix + ran.chooseBotName();
        let o = new Entity(loc);
        o.define(Config.spawn_class);
        o.define({ CONTROLLERS: ["nearestDifferentMaster"] }, false, false, false);
        o.refreshBodyAttributes();
        o.isBot = true;
        o.name = botName;
        o.botName = botName;
        o.invuln = true;
        o.leftoverUpgrades = ran.chooseChance(...Config.bot_class_upgrade_chances);
        let color = Config.random_body_colors ? Math.floor(Math.random() * 20) : team ? getTeamColor(team) : "red";
        o.color.base = color;
        o.leaderboardColor = color;
        o.minimapColor = color;
        o.skill.reset();
        let leveling = setInterval(() => {
            if (o.skill.level < Config.bot_start_level) {
                o.skill.score += o.skill.levelScore;
                o.skill.maintain();
            } else clearInterval(leveling);
        }, 100)
        o.refreshBodyAttributes();
        if (team) o.team = team;
        this.bots.push(o);
        if (Config.tag) Config.tag_data.addBot(o), global.nextTagBotTeam = null;
        setTimeout(() => {
            // allow them to move
            let CC = Class[o.defs[0]];
            if (!CC) CC = {};
            o.controllers = [];
            o.define({
                CONTROLLERS: CC.CONTROLLERS ? [...Class.bot.CONTROLLERS, ...CC.CONTROLLERS] : Class.bot.CONTROLLERS,
                FACING_TYPE: CC.FACING_TYPE ? CC.FACING_TYPE : Class.bot.FACING_TYPE,
                AI: Class.bot.AI
            }, false, true, false)
            if (CC && CC.HEALING_TANK) {
                o.controllers = [];
                o.define({
                    CONTROLLERS: ["healTeamMasters", "minion", ["wanderAroundMap", { replicatePlayerMovement: true, lookAtGoal: true }]],
                    FACING_TYPE: CC.FACING_TYPE ? CC.FACING_TYPE : Class.bot.FACING_TYPE,
                    AI: Class.bot.AI
                }, false, true, false);
            }
            o.name = botName;
            o.refreshBodyAttributes();
            o.invuln = false;
            o.on("define", () => {
                let CC = Class[o.defs[0]];
                if (CC && CC.HEALING_TANK) {
                    o.controllers = [];
                    o.define({ 
                        CONTROLLERS: ["healTeamMasters", "minion", ["wanderAroundMap", { replicatePlayerMovement: true, lookAtGoal: true }]],
                        FACING_TYPE: CC.FACING_TYPE ? CC.FACING_TYPE : Class.bot.FACING_TYPE,
                        AI: Class.bot.AI
                    }, false, true, false);
                }
                o.define({ FACING_TYPE: CC.FACING_TYPE ? CC.FACING_TYPE : Class.bot.FACING_TYPE, AI: Class.bot.AI }, false, true, false) // Just reoverride the facing type.
            })
        }, 3000 + Math.floor(Math.random() * 7000));
        o.on("dead", () => {
            setTimeout(() => {
                if (global.nextTagBotTeam) {
                    let loc = getSpawnableArea(global.nextTagBotTeam, global.gameManager);
                    this.spawnBots(loc, global.nextTagBotTeam);
                }
            }, 10)
            util.remove(this.bots, this.bots.indexOf(o));
        });
    };

    run() {
        this.active = true;
        let gameLoop = setInterval(() => {
            if (!this.active) return clearInterval(gameLoop);
            if (this.checkUsers()) {
                try {
                    this.gameloop();
                    syncedDelaysLoop();
                    if (Config.enable_food) this.foodloop();
                    global.gameManager.roomLoop();
                    global.gameManager.gamemodeManager.request("quickloop");
                } catch(e) {
                    global.gameManager.gameSpeedCheckHandler.onError(e);
                    this.stop();
                };
            }
        }, global.gameManager.room.cycleSpeed);
        let maintainloop = setInterval(() => {
            if (!this.active) return clearInterval(maintainloop);
            global.gameManager.gameSpeedCheckHandler.update();
            global.gameManager.gamemodeManager.request("loop");
            this.maintainloop();
        }, 1000);
        let otherloop = setInterval(() => {
            if (!this.active) return clearInterval(otherloop);
            this.quickMaintainLoop();
            global.gameManager.socketManager.chatLoop();
        }, 200)
        let healingLoop = setInterval(() => {
            if (!this.active) return clearInterval(healingLoop);
            this.regenHealthAndShield();
        }, Config.regenerate_tick);
    }
    stop() {
        this.active = false;
    }
}

module.exports = { gameHandler };
